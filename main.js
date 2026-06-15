const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const si = require('systeminformation');
const path = require('path');
const LogManager = require('./log-manager');

let mainWindow;
let monitoringInterval = null;
let alertThresholds = {
  cpu: 80,
  memory: 80,
  disk: 90,
  network: 100
};
let alertHistory = [];
let maxHistoryPoints = 60;
let logIntervalMs = 60000;
let splitStrategy = 'daily';
let maxFileSize = 50 * 1024 * 1024;

let logManager = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
  });

  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  startMonitoring();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  stopMonitoring();
  if (logManager) {
    await logManager.stop();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function startMonitoring() {
  if (monitoringInterval) return;
  
  monitoringInterval = setInterval(async () => {
    try {
      const data = await collectSystemData();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('system-data', data);
      }
      checkAlerts(data);
      
      if (logManager && logManager.isLogging) {
        logManager.addRecord(data);
      }
    } catch (err) {
      console.error('数据采集错误:', err);
    }
  }, 2000);
}

function stopMonitoring() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
}

async function collectSystemData() {
  const [cpu, mem, fsSize, networkStats, processes] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats(),
    si.processes()
  ]);

  const cpuUsage = cpu.currentLoad;
  const memoryUsage = (mem.active / mem.total) * 100;
  
  let diskUsage = 0;
  if (fsSize && fsSize.length > 0) {
    const mainDisk = fsSize[0];
    diskUsage = mainDisk.use;
  }

  let networkUp = 0;
  let networkDown = 0;
  if (networkStats && networkStats.length > 0) {
    networkStats.forEach(iface => {
      networkUp += iface.tx_sec || 0;
      networkDown += iface.rx_sec || 0;
    });
  }

  const topProcesses = processes.list
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 10)
    .map(p => ({
      pid: p.pid,
      name: p.name,
      cpu: parseFloat(p.cpu.toFixed(2)),
      mem: parseFloat(p.mem.toFixed(2)),
      memBytes: Math.round(p.memVsz || p.memRss || 0)
    }));

  return {
    timestamp: new Date().toISOString(),
    cpu: {
      usage: parseFloat(cpuUsage.toFixed(2)),
      cores: cpu.cpus.length,
      coresLoad: cpu.cpus.map(c => parseFloat(c.load.toFixed(2)))
    },
    memory: {
      usage: parseFloat(memoryUsage.toFixed(2)),
      total: mem.total,
      used: mem.active,
      free: mem.available
    },
    disk: {
      usage: parseFloat(diskUsage.toFixed(2)),
      total: fsSize[0] ? fsSize[0].size : 0,
      used: fsSize[0] ? fsSize[0].used : 0,
      fs: fsSize[0] ? fsSize[0].fs : '',
      mount: fsSize[0] ? fsSize[0].mount : ''
    },
    network: {
      up: networkUp,
      down: networkDown,
      upMB: parseFloat((networkUp / 1024 / 1024).toFixed(2)),
      downMB: parseFloat((networkDown / 1024 / 1024).toFixed(2))
    },
    topProcesses
  };
}

function checkAlerts(data) {
  const alerts = [];
  
  if (data.cpu.usage >= alertThresholds.cpu) {
    alerts.push({
      type: 'cpu',
      level: data.cpu.usage >= 95 ? 'critical' : 'warning',
      message: `CPU使用率过高: ${data.cpu.usage}%`,
      value: data.cpu.usage,
      threshold: alertThresholds.cpu,
      timestamp: data.timestamp
    });
  }
  
  if (data.memory.usage >= alertThresholds.memory) {
    alerts.push({
      type: 'memory',
      level: data.memory.usage >= 95 ? 'critical' : 'warning',
      message: `内存使用率过高: ${data.memory.usage}%`,
      value: data.memory.usage,
      threshold: alertThresholds.memory,
      timestamp: data.timestamp
    });
  }
  
  if (data.disk.usage >= alertThresholds.disk) {
    alerts.push({
      type: 'disk',
      level: data.disk.usage >= 98 ? 'critical' : 'warning',
      message: `磁盘使用率过高: ${data.disk.usage}%`,
      value: data.disk.usage,
      threshold: alertThresholds.disk,
      timestamp: data.timestamp
    });
  }
  
  if (alerts.length > 0) {
    alertHistory.unshift(...alerts);
    if (alertHistory.length > 100) {
      alertHistory = alertHistory.slice(0, 100);
    }
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('alerts', alerts);
    }
  }
}

ipcMain.on('start-logging', async (event) => {
  if (logManager && logManager.isLogging) {
    event.reply('logging-status', getLoggingStatus());
    return;
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择日志保存目录',
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    event.reply('logging-status', { running: false, file: '' });
    return;
  }

  const logDir = result.filePaths[0];

  logManager = new LogManager({
    splitStrategy,
    maxFileSize,
    flushInterval: Math.max(2000, logIntervalMs),
    logDir,
    baseName: 'performance_log'
  });

  logManager.on('file-created', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('log-file-created', info);
    }
  });

  logManager.on('flushed', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('log-flushed', info);
    }
  });

  logManager.on('error', (err) => {
    console.error('日志管理错误:', err);
  });

  try {
    await logManager.start();
    event.reply('logging-status', getLoggingStatus());
  } catch (err) {
    event.reply('logging-status', { running: false, file: '', error: err.message });
  }
});

ipcMain.on('stop-logging', async (event) => {
  if (logManager) {
    await logManager.stop();
  }
  event.reply('logging-status', getLoggingStatus());
});

ipcMain.on('get-logging-status', (event) => {
  event.reply('logging-status', getLoggingStatus());
});

function getLoggingStatus() {
  if (!logManager) {
    return { running: false, file: '', records: 0, files: [] };
  }
  return {
    running: logManager.isLogging,
    file: logManager.getCurrentFile(),
    records: logManager.getCurrentRecordCount(),
    totalRecords: logManager.getTotalRecordCount(),
    files: logManager.getFileList()
  };
}

ipcMain.on('get-alert-history', (event) => {
  event.reply('alert-history', alertHistory);
});

ipcMain.on('update-thresholds', (event, thresholds) => {
  alertThresholds = { ...alertThresholds, ...thresholds };
  if (thresholds.splitStrategy) {
    splitStrategy = thresholds.splitStrategy;
  }
  if (thresholds.maxFileSize) {
    maxFileSize = thresholds.maxFileSize;
  }
  event.reply('thresholds-updated', { ...alertThresholds, splitStrategy, maxFileSize });
});

ipcMain.on('get-thresholds', (event) => {
  event.reply('thresholds-data', { ...alertThresholds, splitStrategy, maxFileSize });
});

ipcMain.on('export-report', async (event, options = {}) => {
  if (!logManager) {
    event.reply('export-error', { error: '未启动日志记录' });
    return;
  }

  const isIncremental = options.isIncremental === true;
  const resumeFromBreakpoint = options.resumeFromBreakpoint === true;
  const exportState = logManager.getExportState();

  let effectiveStartTime = options.startTime;
  let effectiveEndTime = options.endTime;
  let incrementalStart = null;

  if (isIncremental) {
    if (resumeFromBreakpoint && exportState.breakpoint) {
      effectiveStartTime = exportState.breakpoint.lastTimestamp;
      incrementalStart = exportState.breakpoint.incrementalStart;
    } else if (exportState.lastExportTimestamp) {
      effectiveStartTime = exportState.lastExportTimestamp;
      incrementalStart = exportState.lastExportTimestamp;
    }
  }

  const totalRecords = logManager.getTotalRecordCount();
  const remainingRecords = isIncremental ? exportState.remainingRecords : totalRecords;

  if (remainingRecords === 0 && !resumeFromBreakpoint) {
    if (isIncremental) {
      event.reply('export-error', { error: '没有新增数据可导出' });
    } else {
      event.reply('export-error', { error: '没有可导出的数据' });
    }
    return;
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '-');

  let defaultFileName;
  if (isIncremental) {
    const fromStr = incrementalStart ? new Date(incrementalStart).toISOString().replace(/[:.]/g, '-') : 'begin';
    const toStr = now.toISOString().replace(/[:.]/g, '-');
    defaultFileName = `performance_report_INCREMENTAL_${fromStr}_to_${toStr}.${options.format || 'csv'}`;
  } else {
    const filters = [];
    if (options.startTime) filters.push(`开始时间-${options.startTime.replace(/[:.]/g, '-')}`);
    if (options.endTime) filters.push(`结束时间-${options.endTime.replace(/[:.]/g, '-')}`);
    const filterStr = filters.length > 0 ? `_${filters.join('_')}` : '';
    defaultFileName = `performance_report_${dateStr}_${timeStr}${filterStr}.${options.format || 'csv'}`;
  }

  let filePath;
  if (resumeFromBreakpoint && exportState.breakpoint && exportState.breakpoint.outputPath) {
    filePath = exportState.breakpoint.outputPath;
  } else {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: isIncremental ? '增量导出性能报告' : '导出性能报告',
      defaultPath: defaultFileName,
      filters: [
        { name: 'CSV 文件', extensions: ['csv'] },
        { name: 'JSON 文件', extensions: ['json'] }
      ]
    });

    if (result.canceled) return;
    filePath = result.filePath;
  }

  const format = filePath.endsWith('.csv') ? 'csv' : filePath.endsWith('.jsonl') ? 'jsonl' : 'json';
  
  try {
    const exportResult = await logManager.exportReport({
      format,
      outputPath: filePath,
      startTime: effectiveStartTime,
      endTime: effectiveEndTime,
      includeProcesses: options.includeProcesses !== false,
      isIncremental,
      resumeFromBreakpoint
    });
    
    event.reply('export-success', { 
      file: filePath, 
      count: exportResult.totalExported,
      isIncremental: exportResult.isIncremental,
      incrementalFrom: exportResult.incrementalFrom,
      incrementalTo: exportResult.incrementalTo,
      outputFileSize: exportResult.outputFileSize,
      totalRecords,
      savedRecords: isIncremental ? (totalRecords - exportResult.totalExported) : 0,
      savedTimeEstimate: isIncremental ? Math.round((totalRecords - exportResult.totalExported) / totalRecords * 100) : 0
    });
  } catch (err) {
    event.reply('export-error', { error: err.message });
  }
});

ipcMain.on('get-export-state', (event) => {
  if (!logManager) {
    event.reply('export-state', {
      lastExportTimestamp: null,
      lastExportFile: null,
      lastExportCount: 0,
      lastExportTime: null,
      lastExportSize: 0,
      totalExportedCount: 0,
      breakpoint: null,
      isPartialExport: false,
      totalRecords: 0,
      remainingRecords: 0,
      hasPendingExports: false
    });
    return;
  }
  event.reply('export-state', logManager.getExportState());
});

ipcMain.on('reset-export-state', async (event) => {
  if (!logManager) {
    event.reply('export-state-reset', { success: false, error: '未启动日志记录' });
    return;
  }
  try {
    const state = await logManager.resetExportState();
    event.reply('export-state-reset', { success: true, state });
  } catch (err) {
    event.reply('export-state-reset', { success: false, error: err.message });
  }
});

ipcMain.on('query-history', async (event, options = {}) => {
  if (!logManager) {
    event.reply('history-result', { data: [], total: 0, hasMore: false });
    return;
  }

  try {
    const result = await logManager.queryRecords(options);
    event.reply('history-result', result);
  } catch (err) {
    event.reply('history-result', { data: [], total: 0, hasMore: false, error: err.message });
  }
});

ipcMain.on('get-log-files', (event) => {
  if (!logManager) {
    event.reply('log-files', []);
    return;
  }
  event.reply('log-files', logManager.getFileList());
});

ipcMain.on('set-log-interval', (event, ms) => {
  logIntervalMs = ms;
  event.reply('log-interval-updated', logIntervalMs);
});

ipcMain.on('delete-old-logs', async (event, daysToKeep) => {
  if (!logManager) {
    event.reply('old-logs-deleted', { count: 0 });
    return;
  }
  
  try {
    const count = await logManager.deleteOldFiles(daysToKeep);
    event.reply('old-logs-deleted', { count });
  } catch (err) {
    event.reply('export-error', { error: err.message });
  }
});

ipcMain.on('get-history-data', (event) => {
  event.reply('history-data', []);
});
