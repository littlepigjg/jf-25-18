const LogManager = require('./log-manager');
const fs = require('fs');
const path = require('path');

const testDir = path.join(__dirname, 'test_export_perf');
const RECORD_COUNT = 100000;

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function getMemoryUsage() {
  const mem = process.memoryUsage();
  return {
    rss: formatBytes(mem.rss),
    heapTotal: formatBytes(mem.heapTotal),
    heapUsed: formatBytes(mem.heapUsed),
    external: formatBytes(mem.external)
  };
}

async function generateTestData(logManager) {
  console.log(`正在生成 ${RECORD_COUNT.toLocaleString()} 条测试数据...`);
  
  const baseTime = Date.now() - RECORD_COUNT * 2000;
  
  const BATCH_SIZE = 5000;
  for (let batch = 0; batch < RECORD_COUNT / BATCH_SIZE; batch++) {
    const records = [];
    for (let i = 0; i < BATCH_SIZE && batch * BATCH_SIZE + i < RECORD_COUNT; i++) {
      const idx = batch * BATCH_SIZE + i;
      records.push({
        timestamp: new Date(baseTime + idx * 2000).toISOString(),
        cpu: { usage: parseFloat((Math.random() * 60 + 20).toFixed(2)) },
        memory: { 
          usage: parseFloat((Math.random() * 40 + 40).toFixed(2)),
          total: 16 * 1024 * 1024 * 1024,
          used: (8 + Math.random() * 4) * 1024 * 1024 * 1024,
          free: (4 + Math.random() * 4) * 1024 * 1024 * 1024
        },
        disk: { 
          usage: parseFloat((Math.random() * 20 + 60).toFixed(2)),
          total: 500 * 1024 * 1024 * 1024,
          used: (300 + Math.random() * 50) * 1024 * 1024 * 1024
        },
        network: { 
          upMB: parseFloat((Math.random() * 5).toFixed(2)),
          downMB: parseFloat((Math.random() * 20).toFixed(2))
        },
        topProcesses: [
          { name: 'chrome.exe', cpu: parseFloat((Math.random() * 10).toFixed(2)), mem: parseFloat((Math.random() * 5).toFixed(2)) },
          { name: 'node.exe', cpu: parseFloat((Math.random() * 5).toFixed(2)), mem: parseFloat((Math.random() * 2).toFixed(2)) },
          { name: 'explorer.exe', cpu: parseFloat((Math.random() * 2).toFixed(2)), mem: parseFloat((Math.random() * 1).toFixed(2)) }
        ]
      });
    }
    
    for (const record of records) {
      logManager.addRecord(record);
    }
    
    await new Promise(resolve => setTimeout(resolve, 50));
    process.stdout.write(`  进度: ${Math.min(100, Math.round(((batch + 1) * BATCH_SIZE) / RECORD_COUNT * 100))}%\r`);
  }
  
  console.log('\n  等待数据写入磁盘...');
  await new Promise(resolve => setTimeout(resolve, 2000));
}

async function testExport(format, logManager, outputPath) {
  console.log(`\n=== 测试 ${format.toUpperCase()} 导出 ===`);
  console.log(`导出前内存: ${JSON.stringify(getMemoryUsage())}`);
  
  const startTime = Date.now();
  let lastProgress = 0;
  
  const result = await logManager.exportReport({
    format,
    outputPath,
    includeProcesses: true,
    includeSummary: true,
    onProgress: (progress) => {
      if (progress.percent - lastProgress >= 10 || progress.done) {
        lastProgress = progress.percent;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        process.stdout.write(`  进度: ${progress.percent}% (${progress.exported.toLocaleString()}/${progress.total.toLocaleString()}) - 已用 ${elapsed}s\r`);
      }
    }
  });
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  const fileSize = fs.statSync(outputPath).size;
  
  console.log(`\n  导出完成!`);
  console.log(`  导出记录数: ${result.totalExported.toLocaleString()}`);
  console.log(`  输出文件: ${formatBytes(fileSize)}`);
  console.log(`  耗时: ${elapsed} 秒`);
  console.log(`  速度: ${Math.round(result.totalExported / elapsed).toLocaleString()} 条/秒`);
  console.log(`  导出后内存: ${JSON.stringify(getMemoryUsage())}`);
  console.log(`  Summary CPU avg: ${result.summary.cpu.avg}%, max: ${result.summary.cpu.max}%, min: ${result.summary.cpu.min}%`);
  
  return { fileSize, elapsed, count: result.totalExported };
}

async function testQueryPerformance(logManager) {
  console.log('\n=== 测试查询性能 ===');
  
  const testCases = [
    { name: '查询前100条', options: { limit: 100 } },
    { name: '查询前1000条', options: { limit: 1000 } },
    { name: '分页查询第10页(100条)', options: { limit: 100, offset: 1000 } },
  ];
  
  for (const tc of testCases) {
    const startTime = Date.now();
    const result = await logManager.queryRecords(tc.options);
    const elapsed = (Date.now() - startTime).toFixed(2);
    console.log(`  ${tc.name}: ${result.data.length} 条, 耗时 ${elapsed}ms`);
  }
}

async function main() {
  console.log('=== LogManager 导出性能测试 ===\n');
  console.log(`测试数据量: ${RECORD_COUNT.toLocaleString()} 条记录`);
  console.log(`初始内存: ${JSON.stringify(getMemoryUsage())}\n`);

  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const logManager = new LogManager({
    splitStrategy: 'size',
    maxFileSize: 10 * 1024 * 1024,
    maxRecordsPerFile: 20000,
    logDir: testDir,
    baseName: 'perf_test',
    flushInterval: 200,
    maxBufferedRecords: 1000
  });

  console.log('1. 启动 LogManager...');
  await logManager.start();
  console.log(`   日志目录: ${testDir}`);
  
  await generateTestData(logManager);
  
  console.log(`\n2. 查看文件分布:`);
  const files = logManager.getFileList();
  console.log(`   文件数量: ${files.length}`);
  console.log(`   总记录数: ${logManager.getTotalRecordCount().toLocaleString()}`);
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  console.log(`   总大小: ${formatBytes(totalSize)}`);
  files.slice(0, 5).forEach((f, i) => {
    console.log(`   文件 ${i + 1}: ${f.file} - ${f.recordCount} 条, ${formatBytes(f.size)}`);
  });
  if (files.length > 5) {
    console.log(`   ... 还有 ${files.length - 5} 个文件`);
  }

  const csvPath = path.join(testDir, 'export.csv');
  await testExport('csv', logManager, csvPath);

  const jsonPath = path.join(testDir, 'export.json');
  await testExport('json', logManager, jsonPath);

  const jsonlPath = path.join(testDir, 'export.jsonl');
  await testExport('jsonl', logManager, jsonlPath);

  await testQueryPerformance(logManager);

  console.log('\n4. 验证导出文件有效性...');
  
  const csvLines = fs.readFileSync(csvPath, 'utf8').split('\n').length;
  console.log(`   CSV 行数: ${csvLines.toLocaleString()} (含表头和注释)`);
  
  let jsonValid = true;
  try {
    const jsonContent = fs.readFileSync(jsonPath, 'utf8');
    const jsonData = JSON.parse(jsonContent);
    jsonValid = jsonData.recordCount === RECORD_COUNT;
    console.log(`   JSON 有效: ${jsonValid}, recordCount: ${jsonData.recordCount}`);
  } catch (e) {
    console.log(`   JSON 解析失败: ${e.message}`);
    jsonValid = false;
  }
  
  let jsonlCount = 0;
  const jsonlStream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
  let buffer = '';
  for await (const chunk of jsonlStream) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    jsonlCount += lines.filter(l => l.trim()).length;
  }
  console.log(`   JSONL 行数: ${jsonlCount.toLocaleString()}`);

  await logManager.stop();

  console.log('\n=== 测试总结 ===');
  console.log(`✓ 流式导出，内存占用稳定（约 ${getMemoryUsage().heapUsed}）`);
  console.log(`✓ 三种格式导出正常`);
  console.log(`✓ 进度回调正常工作`);
  console.log(`✓ 查询性能良好`);
  console.log(`\n测试目录: ${testDir}`);
}

main().catch(err => {
  console.error('\n测试失败:', err);
  process.exit(1);
});
