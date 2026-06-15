const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_OPTIONS = {
  splitStrategy: 'daily',
  maxFileSize: 50 * 1024 * 1024,
  maxRecordsPerFile: 10000,
  logDir: '',
  baseName: 'performance_log',
  flushInterval: 5000,
  maxBufferedRecords: 1000,
  encoding: 'utf-8'
};

class LogManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.isLogging = false;
    this.currentFile = '';
    this.currentFileSize = 0;
    this.currentRecordCount = 0;
    this.currentFileStartDate = null;
    this.buffer = [];
    this.flushTimer = null;
    this.fileIndex = [];
    this.writeStream = null;
    this.isFlushing = false;
    this.exportState = {
      lastExportTimestamp: null,
      lastExportFile: null,
      lastExportCount: 0,
      lastExportTime: null,
      lastExportSize: 0,
      totalExportedCount: 0,
      breakpoint: null,
      isPartialExport: false
    };
  }

  async start(logDir) {
    if (this.isLogging) return;

    if (logDir) {
      this.options.logDir = logDir;
    }

    if (!this.options.logDir) {
      throw new Error('日志目录未指定');
    }

    if (!fs.existsSync(this.options.logDir)) {
      fs.mkdirSync(this.options.logDir, { recursive: true });
    }

    await this._loadFileIndex();
    await this._loadExportState();
    await this._createNewFile();
    this.isLogging = true;

    this.flushTimer = setInterval(() => {
      this._flush();
    }, this.options.flushInterval);

    this.emit('started', { file: this.currentFile });
  }

  async stop() {
    if (!this.isLogging) return;

    this.isLogging = false;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    await this._flush(true);
    await this._closeWriteStream();
    await this._saveFileIndex();
    await this._saveExportState();

    this.emit('stopped', { 
      file: this.currentFile, 
      totalRecords: this.getTotalRecordCount() 
    });
  }

  addRecord(record) {
    if (!this.isLogging) return false;

    const recordWithMeta = {
      ...record,
      _seq: Date.now() + Math.random()
    };

    this.buffer.push(recordWithMeta);

    if (this.buffer.length >= this.options.maxBufferedRecords) {
      setImmediate(() => this._flush());
    }

    this.emit('record-added', { count: this.buffer.length });
    return true;
  }

  async _createNewFile() {
    await this._closeWriteStream();

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '-');
    
    let baseFileName;
    if (this.options.splitStrategy === 'size') {
      baseFileName = `${this.options.baseName}_${dateStr}_${timeStr}`;
    } else {
      baseFileName = `${this.options.baseName}_${dateStr}`;
    }

    let fileIndex = 0;
    let fileName, filePath;
    do {
      const suffix = fileIndex > 0 ? `_${fileIndex}` : '';
      fileName = `${baseFileName}${suffix}.jsonl`;
      filePath = path.join(this.options.logDir, fileName);
      fileIndex++;
    } while (fs.existsSync(filePath));

    this.currentFile = filePath;

    this.writeStream = fs.createWriteStream(this.currentFile, {
      flags: 'a',
      encoding: this.options.encoding
    });

    this.currentFileSize = 0;
    this.currentRecordCount = 0;
    this.currentFileStartDate = now;

    const indexEntry = {
      file: fileName,
      startTime: now.toISOString(),
      endTime: now.toISOString(),
      recordCount: 0,
      size: 0
    };
    this.fileIndex.push(indexEntry);

    this.emit('file-created', { file: this.currentFile });
  }

  async _checkAndSplit(pendingRecords = []) {
    let needSplit = false;

    if (this.currentRecordCount > 0) {
      if (this.options.splitStrategy === 'daily') {
        const today = new Date().toISOString().slice(0, 10);
        const fileDay = this.currentFileStartDate.toISOString().slice(0, 10);
        if (today !== fileDay) {
          needSplit = true;
        }
      }

      const pendingSize = pendingRecords.reduce((sum, r) => {
        return sum + Buffer.byteLength(JSON.stringify(r) + '\n', this.options.encoding);
      }, 0);

      const projectedSize = this.currentFileSize + pendingSize;
      const projectedCount = this.currentRecordCount + pendingRecords.length;

      if (projectedSize >= this.options.maxFileSize || projectedCount >= this.options.maxRecordsPerFile) {
        needSplit = true;
      }
    }

    if (needSplit) {
      await this._saveFileIndex();
      await this._createNewFile();
    }
  }

  async _flush(force = false) {
    if (this.isFlushing || (this.buffer.length === 0 && !force)) return;
    
    this.isFlushing = true;
    const recordsToWrite = [...this.buffer];
    this.buffer = [];

    try {
      await this._checkAndSplit(recordsToWrite);

      const lines = recordsToWrite.map(r => JSON.stringify(r));
      const dataToWrite = lines.join('\n') + '\n';
      const byteLength = Buffer.byteLength(dataToWrite, this.options.encoding);

      await new Promise((resolve, reject) => {
        if (!this.writeStream) {
          reject(new Error('Write stream not available'));
          return;
        }
        this.writeStream.write(dataToWrite, this.options.encoding, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      this.currentFileSize += byteLength;
      this.currentRecordCount += recordsToWrite.length;

      const lastIndex = this.fileIndex.length - 1;
      if (lastIndex >= 0) {
        this.fileIndex[lastIndex].endTime = recordsToWrite[recordsToWrite.length - 1]?.timestamp || new Date().toISOString();
        this.fileIndex[lastIndex].recordCount = this.currentRecordCount;
        this.fileIndex[lastIndex].size = this.currentFileSize;
      }

      this.emit('flushed', { 
        count: recordsToWrite.length, 
        file: this.currentFile,
        totalInFile: this.currentRecordCount
      });

    } catch (err) {
      this.buffer.unshift(...recordsToWrite);
      this.emit('error', { type: 'flush', error: err.message });
    } finally {
      this.isFlushing = false;
    }
  }

  async _closeWriteStream() {
    if (this.writeStream) {
      await new Promise(resolve => {
        this.writeStream.end(() => resolve());
      });
      this.writeStream = null;
    }
  }

  async _loadFileIndex() {
    const indexPath = path.join(this.options.logDir, '.log_index.json');
    this.fileIndex = [];

    if (fs.existsSync(indexPath)) {
      try {
        const content = fs.readFileSync(indexPath, this.options.encoding);
        this.fileIndex = JSON.parse(content);
      } catch (err) {
        this.fileIndex = [];
      }
    }

    if (this.fileIndex.length === 0) {
      await this._rebuildIndex();
    }
  }

  async _rebuildIndex() {
    const files = fs.readdirSync(this.options.logDir)
      .filter(f => f.startsWith(this.options.baseName) && f.endsWith('.jsonl'))
      .sort();

    this.fileIndex = [];

    for (const file of files) {
      const filePath = path.join(this.options.logDir, file);
      const stats = fs.statSync(filePath);
      
      let firstRecord = null;
      let lastRecord = null;
      let count = 0;

      try {
        const stream = fs.createReadStream(filePath, { encoding: this.options.encoding });
        let buffer = '';
        
        for await (const chunk of stream) {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop();
          
          for (const line of lines) {
            if (line.trim()) {
              count++;
              try {
                const record = JSON.parse(line);
                if (!firstRecord) firstRecord = record;
                lastRecord = record;
              } catch {}
            }
          }
        }
      } catch {}

      if (count > 0) {
        this.fileIndex.push({
          file,
          startTime: firstRecord?.timestamp || stats.birthtime.toISOString(),
          endTime: lastRecord?.timestamp || stats.mtime.toISOString(),
          recordCount: count,
          size: stats.size
        });
      } else {
        try {
          fs.unlinkSync(filePath);
        } catch {}
      }
    }

    await this._saveFileIndex();
  }

  async _saveFileIndex() {
    const indexPath = path.join(this.options.logDir, '.log_index.json');
    try {
      fs.writeFileSync(indexPath, JSON.stringify(this.fileIndex, null, 2), this.options.encoding);
    } catch (err) {
      this.emit('error', { type: 'save-index', error: err.message });
    }
  }

  async _loadExportState() {
    const statePath = path.join(this.options.logDir, '.export_state.json');
    if (fs.existsSync(statePath)) {
      try {
        const content = fs.readFileSync(statePath, this.options.encoding);
        this.exportState = { ...this.exportState, ...JSON.parse(content) };
      } catch (err) {
        this.emit('error', { type: 'load-export-state', error: err.message });
      }
    }
  }

  async _saveExportState() {
    const statePath = path.join(this.options.logDir, '.export_state.json');
    try {
      fs.writeFileSync(statePath, JSON.stringify(this.exportState, null, 2), this.options.encoding);
    } catch (err) {
      this.emit('error', { type: 'save-export-state', error: err.message });
    }
  }

  getExportState() {
    const totalRecords = this.getTotalRecordCount();
    const remainingRecords = Math.max(0, totalRecords - this.exportState.totalExportedCount);
    return {
      ...this.exportState,
      totalRecords,
      remainingRecords,
      hasPendingExports: remainingRecords > 0 || this.exportState.isPartialExport
    };
  }

  async resetExportState() {
    this.exportState = {
      lastExportTimestamp: null,
      lastExportFile: null,
      lastExportCount: 0,
      lastExportTime: null,
      lastExportSize: 0,
      totalExportedCount: 0,
      breakpoint: null,
      isPartialExport: false
    };
    await this._saveExportState();
    return this.exportState;
  }

  async queryRecords(options = {}) {
    const { 
      startTime, 
      endTime, 
      limit = 1000, 
      offset = 0,
      filters = {}
    } = options;

    const matchingFiles = this._findMatchingFiles(startTime, endTime);
    const results = [];
    let skipped = 0;

    for (const indexEntry of matchingFiles) {
      if (results.length >= limit) break;

      const filePath = path.join(this.options.logDir, indexEntry.file);
      const records = await this._readFileRecords(filePath, {
        startTime,
        endTime,
        filters,
        limit: limit - results.length,
        skip: Math.max(0, offset - skipped)
      });

      skipped += records.skipped;
      results.push(...records.data);
    }

    return {
      data: results,
      total: this._estimateTotalCount(matchingFiles, startTime, endTime),
      hasMore: results.length >= limit
    };
  }

  _findMatchingFiles(startTime, endTime) {
    return this.fileIndex.filter(entry => {
      if (startTime && entry.endTime < startTime) return false;
      if (endTime && entry.startTime > endTime) return false;
      return true;
    });
  }

  async _readFileRecords(filePath, options) {
    const { startTime, endTime, filters, limit, skip } = options;
    const results = [];
    let skipped = 0;
    let readCount = 0;

    const stream = fs.createReadStream(filePath, { encoding: this.options.encoding });
    let buffer = '';

    for await (const chunk of stream) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        
        if (skip > 0 && skipped < skip) {
          skipped++;
          continue;
        }

        if (results.length >= limit) break;

        try {
          const record = JSON.parse(line);
          
          if (startTime && record.timestamp < startTime) continue;
          if (endTime && record.timestamp > endTime) continue;
          
          let match = true;
          for (const [key, value] of Object.entries(filters)) {
            const keys = key.split('.');
            let r = record;
            for (const k of keys) {
              r = r?.[k];
            }
            if (r !== value) {
              match = false;
              break;
            }
          }
          
          if (match) {
            results.push(record);
          }
        } catch {}
      }

      if (results.length >= limit) break;
    }

    return { data: results, skipped, readCount };
  }

  _estimateTotalCount(files, startTime, endTime) {
    return files.reduce((sum, f) => sum + f.recordCount, 0);
  }

  async exportReport(options) {
    const { 
      format = 'csv', 
      outputPath, 
      startTime, 
      endTime,
      includeProcesses = true,
      includeSummary = true,
      fields = null,
      onProgress = null,
      isIncremental = false,
      resumeFromBreakpoint = false
    } = options;

    let effectiveStartTime = startTime;
    let incrementalStartTimestamp = null;

    if (isIncremental) {
      if (resumeFromBreakpoint && this.exportState.breakpoint) {
        const bp = this.exportState.breakpoint;
        effectiveStartTime = bp.lastTimestamp;
        incrementalStartTimestamp = bp.incrementalStart;
      } else if (this.exportState.lastExportTimestamp) {
        effectiveStartTime = this.exportState.lastExportTimestamp;
        incrementalStartTimestamp = this.exportState.lastExportTimestamp;
      } else {
        effectiveStartTime = null;
        incrementalStartTimestamp = null;
      }
    }

    const matchingFiles = this._findMatchingFiles(effectiveStartTime, endTime);
    const totalEstimated = this._estimateTotalCount(matchingFiles, effectiveStartTime, endTime);
    let totalExported = 0;
    let processedCount = 0;
    let lastProgressEmit = 0;
    let lastRecordTimestamp = incrementalStartTimestamp || effectiveStartTime || null;
    let fileIndexOffset = 0;
    let lineByteOffset = 0;
    let currentFileName = '';
    let isFirstRecord = true;

    if (isIncremental && resumeFromBreakpoint && this.exportState.breakpoint) {
      const bp = this.exportState.breakpoint;
      fileIndexOffset = bp.fileIndex;
      lineByteOffset = bp.lineByteOffset;
      totalExported = bp.exportedCount;
      isFirstRecord = !bp.headerWritten;
    }

    const summary = {
      cpu: { sum: 0, count: 0, avg: 0, max: -Infinity, min: Infinity },
      memory: { sum: 0, count: 0, avg: 0, max: -Infinity, min: Infinity },
      disk: { sum: 0, count: 0, avg: 0, max: -Infinity, min: Infinity }
    };

    const saveBreakpoint = async () => {
      if (!isIncremental) return;
      this.exportState.breakpoint = {
        fileIndex: fileIndexOffset,
        lineByteOffset,
        lastTimestamp: lastRecordTimestamp,
        exportedCount: totalExported,
        headerWritten: !isFirstRecord || format === 'jsonl',
        incrementalStart: incrementalStartTimestamp,
        outputPath,
        format,
        includeProcesses,
        startTime: effectiveStartTime,
        endTime
      };
      this.exportState.isPartialExport = true;
      await this._saveExportState();
    };

    const emitProgress = () => {
      if (onProgress && totalEstimated > 0) {
        const now = Date.now();
        if (now - lastProgressEmit >= 200) {
          lastProgressEmit = now;
          onProgress({
            exported: totalExported,
            total: totalEstimated,
            percent: Math.min(100, Math.round((totalExported / totalEstimated) * 100)),
            currentFile: currentFileName || matchingFiles[Math.min(matchingFiles.length - 1, 
              Math.floor((processedCount / Math.max(1, totalEstimated)) * matchingFiles.length))]?.file || ''
          });
        }
      }
    };

    const writeFlags = (isIncremental && resumeFromBreakpoint && this.exportState.breakpoint) ? 'a' : 'w';
    const writeStream = fs.createWriteStream(outputPath, { 
      encoding: this.options.encoding,
      flags: writeFlags
    });
    
    const writeAsync = (data) => {
      return new Promise((resolve, reject) => {
        if (writeStream.write(data, this.options.encoding)) {
          resolve();
        } else {
          writeStream.once('drain', resolve);
        }
      });
    };

    let checkpointCounter = 0;
    const CHECKPOINT_INTERVAL = 500;

    try {
      if (writeFlags === 'w') {
        isFirstRecord = true;
        if (format === 'csv') {
          const headers = [
            '时间',
            'CPU使用率(%)',
            '内存使用率(%)',
            '磁盘使用率(%)',
            '网络上传(MB/s)',
            '网络下载(MB/s)',
            '内存已用(GB)',
            '内存总量(GB)',
            '磁盘已用(GB)',
            '磁盘总量(GB)'
          ];
          if (includeProcesses) {
            headers.push('Top进程名称', 'Top进程CPU(%)', 'Top进程内存(%)');
          }
          await writeAsync(headers.join(',') + '\n');
        } else if (format === 'json') {
          await writeAsync('{\n');
          await writeAsync(`  "generatedAt": "${new Date().toISOString()}",\n`);
          await writeAsync(`  "startTime": ${effectiveStartTime ? `"${effectiveStartTime}"` : 'null'},\n`);
          await writeAsync(`  "endTime": ${endTime ? `"${endTime}"` : 'null'},\n`);
          if (isIncremental) {
            await writeAsync(`  "exportMode": "incremental",\n`);
            await writeAsync(`  "incrementalFrom": ${incrementalStartTimestamp ? `"${incrementalStartTimestamp}"` : 'null'},\n`);
          }
          await writeAsync('  "data": [\n');
        }
      }

      for (let i = fileIndexOffset; i < matchingFiles.length; i++) {
        const indexEntry = matchingFiles[i];
        fileIndexOffset = i;
        const filePath = path.join(this.options.logDir, indexEntry.file);
        currentFileName = indexEntry.file;
        
        const stream = fs.createReadStream(filePath, { 
          encoding: this.options.encoding,
          highWaterMark: 64 * 1024,
          start: i === fileIndexOffset ? lineByteOffset : 0
        });
        let buffer = '';
        let bytesReadInFile = i === fileIndexOffset ? lineByteOffset : 0;

        for await (const chunk of stream) {
          buffer += chunk;
          bytesReadInFile += Buffer.byteLength(chunk, this.options.encoding);
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.trim()) continue;
            
            let record;
            try {
              record = JSON.parse(line);
            } catch {
              continue;
            }
            
            if (effectiveStartTime && record.timestamp <= effectiveStartTime) continue;
            if (endTime && record.timestamp > endTime) continue;

            summary.cpu.sum += record.cpu.usage;
            summary.cpu.count++;
            summary.cpu.max = Math.max(summary.cpu.max, record.cpu.usage);
            summary.cpu.min = Math.min(summary.cpu.min, record.cpu.usage);
            
            summary.memory.sum += record.memory.usage;
            summary.memory.count++;
            summary.memory.max = Math.max(summary.memory.max, record.memory.usage);
            summary.memory.min = Math.min(summary.memory.min, record.memory.usage);
            
            summary.disk.sum += record.disk.usage;
            summary.disk.count++;
            summary.disk.max = Math.max(summary.disk.max, record.disk.usage);
            summary.disk.min = Math.min(summary.disk.min, record.disk.usage);

            if (format === 'csv') {
              const row = [
                record.timestamp,
                record.cpu.usage,
                record.memory.usage,
                record.disk.usage,
                record.network.upMB,
                record.network.downMB,
                (record.memory.used / 1024 / 1024 / 1024).toFixed(2),
                (record.memory.total / 1024 / 1024 / 1024).toFixed(2),
                (record.disk.used / 1024 / 1024 / 1024).toFixed(2),
                (record.disk.total / 1024 / 1024 / 1024).toFixed(2)
              ];
              if (includeProcesses && record.topProcesses && record.topProcesses[0]) {
                row.push(
                  `"${record.topProcesses[0].name.replace(/"/g, '""')}"`,
                  record.topProcesses[0].cpu,
                  record.topProcesses[0].mem
                );
              }
              await writeAsync(row.join(',') + '\n');
            } else if (format === 'jsonl') {
              await writeAsync(JSON.stringify(record) + '\n');
            } else {
              if (!isFirstRecord) await writeAsync(',\n');
              await writeAsync(`    ${JSON.stringify(record)}`);
              isFirstRecord = false;
            }

            lastRecordTimestamp = record.timestamp;
            totalExported++;
            processedCount++;
            lineByteOffset = bytesReadInFile - Buffer.byteLength(buffer, this.options.encoding);
            
            checkpointCounter++;
            if (checkpointCounter >= CHECKPOINT_INTERVAL) {
              checkpointCounter = 0;
              await saveBreakpoint();
            }
            
            emitProgress();
          }
        }
        lineByteOffset = 0;
      }

      if (format === 'csv') {
        if (includeSummary) {
          const calcAvg = (s) => s.count > 0 ? parseFloat((s.sum / s.count).toFixed(2)) : 0;
          await writeAsync('\n');
          await writeAsync('# 统计摘要\n');
          if (isIncremental) {
            await writeAsync(`# 导出模式: 增量导出\n`);
            if (incrementalStartTimestamp) {
              await writeAsync(`# 增量起点: ${incrementalStartTimestamp}\n`);
            }
          }
          await writeAsync(`# CPU - 平均:${calcAvg(summary.cpu)}%, 最高:${summary.cpu.max.toFixed(2)}%, 最低:${summary.cpu.min.toFixed(2)}%\n`);
          await writeAsync(`# 内存 - 平均:${calcAvg(summary.memory)}%, 最高:${summary.memory.max.toFixed(2)}%, 最低:${summary.memory.min.toFixed(2)}%\n`);
          await writeAsync(`# 磁盘 - 平均:${calcAvg(summary.disk)}%, 最高:${summary.disk.max.toFixed(2)}%, 最低:${summary.disk.min.toFixed(2)}%\n`);
          await writeAsync(`# 总记录数: ${totalExported}\n`);
        }
      } else if (format === 'json') {
        const calcAvg = (s) => s.count > 0 ? parseFloat((s.sum / s.count).toFixed(2)) : 0;
        
        await writeAsync('\n  ],\n');
        
        if (includeSummary) {
          const finalSummary = {
            cpu: { 
              avg: calcAvg(summary.cpu), 
              max: parseFloat(summary.cpu.max.toFixed(2)), 
              min: parseFloat(summary.cpu.min.toFixed(2)) 
            },
            memory: { 
              avg: calcAvg(summary.memory), 
              max: parseFloat(summary.memory.max.toFixed(2)), 
              min: parseFloat(summary.memory.min.toFixed(2)) 
            },
            disk: { 
              avg: calcAvg(summary.disk), 
              max: parseFloat(summary.disk.max.toFixed(2)), 
              min: parseFloat(summary.disk.min.toFixed(2)) 
            }
          };
          await writeAsync(`  "summary": ${JSON.stringify(finalSummary, null, 2)},\n`);
        }
        
        await writeAsync(`  "recordCount": ${totalExported}\n`);
        await writeAsync('}\n');
      }

      await new Promise(resolve => writeStream.end(resolve));

      let outputFileSize = 0;
      try {
        const stats = fs.statSync(outputPath);
        outputFileSize = stats.size;
      } catch {}

      if (isIncremental) {
        this.exportState.lastExportTimestamp = lastRecordTimestamp || this.exportState.lastExportTimestamp;
        this.exportState.lastExportFile = outputPath;
        this.exportState.lastExportCount = totalExported;
        this.exportState.lastExportTime = new Date().toISOString();
        this.exportState.lastExportSize = outputFileSize;
        this.exportState.totalExportedCount += totalExported;
        this.exportState.breakpoint = null;
        this.exportState.isPartialExport = false;
        await this._saveExportState();
      }

      if (onProgress) {
        onProgress({
          exported: totalExported,
          total: totalExported,
          percent: 100,
          done: true
        });
      }

      const finalSummary = {
        cpu: { 
          avg: summary.cpu.count > 0 ? parseFloat((summary.cpu.sum / summary.cpu.count).toFixed(2)) : 0,
          max: parseFloat(summary.cpu.max.toFixed(2)),
          min: parseFloat(summary.cpu.min.toFixed(2))
        },
        memory: {
          avg: summary.memory.count > 0 ? parseFloat((summary.memory.sum / summary.memory.count).toFixed(2)) : 0,
          max: parseFloat(summary.memory.max.toFixed(2)),
          min: parseFloat(summary.memory.min.toFixed(2))
        },
        disk: {
          avg: summary.disk.count > 0 ? parseFloat((summary.disk.sum / summary.disk.count).toFixed(2)) : 0,
          max: parseFloat(summary.disk.max.toFixed(2)),
          min: parseFloat(summary.disk.min.toFixed(2))
        }
      };

      return { 
        totalExported, 
        outputPath, 
        summary: finalSummary,
        isIncremental,
        incrementalFrom: incrementalStartTimestamp,
        incrementalTo: lastRecordTimestamp,
        outputFileSize
      };
    } catch (err) {
      writeStream.destroy();
      if (isIncremental && totalExported > 0) {
        await saveBreakpoint();
      }
      throw err;
    }
  }

  getFileList() {
    return [...this.fileIndex];
  }

  getTotalRecordCount() {
    return this.fileIndex.reduce((sum, f) => sum + f.recordCount, 0) + this.buffer.length;
  }

  getCurrentFile() {
    return this.currentFile;
  }

  getCurrentRecordCount() {
    return this.currentRecordCount + this.buffer.length;
  }

  async deleteOldFiles(daysToKeep) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffStr = cutoffDate.toISOString();

    const toDelete = this.fileIndex.filter(f => f.endTime < cutoffStr);
    let deletedCount = 0;

    for (const entry of toDelete) {
      const filePath = path.join(this.options.logDir, entry.file);
      try {
        fs.unlinkSync(filePath);
        deletedCount++;
      } catch {}
    }

    this.fileIndex = this.fileIndex.filter(f => f.endTime >= cutoffStr);
    await this._saveFileIndex();

    this.emit('files-deleted', { count: deletedCount });
    return deletedCount;
  }

  async mergeFiles(options = {}) {
    const { outputPath, startTime, endTime } = options;
    const result = await this.exportReport({
      format: 'json',
      outputPath,
      startTime,
      endTime
    });
    return result;
  }
}

module.exports = LogManager;
