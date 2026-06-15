const LogManager = require('./log-manager');
const fs = require('fs');
const path = require('path');

const testDir = path.join(__dirname, 'test_logs');

async function testLogManager() {
  console.log('=== 开始测试 LogManager ===\n');

  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const logManager = new LogManager({
    splitStrategy: 'size',
    maxFileSize: 5 * 1024,
    maxRecordsPerFile: 10,
    logDir: testDir,
    baseName: 'test_log',
    flushInterval: 100,
    maxBufferedRecords: 5
  });

  console.log('1. 测试 start()...');
  await logManager.start();
  console.log('   ✓ 启动成功');
  console.log(`   当前文件: ${path.basename(logManager.getCurrentFile())}`);

  console.log('\n2. 测试 addRecord()...');
  for (let i = 0; i < 25; i++) {
    logManager.addRecord({
      timestamp: new Date().toISOString(),
      cpu: { usage: Math.random() * 100 },
      memory: { usage: Math.random() * 100 },
      disk: { usage: Math.random() * 100 },
      network: { upMB: Math.random() * 10, downMB: Math.random() * 10 },
      topProcesses: [{ name: 'test', cpu: 10, mem: 5 }]
    });
    if ((i + 1) % 5 === 0) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  console.log('   ✓ 添加了 25 条记录');
  
  await new Promise(resolve => setTimeout(resolve, 500));
  
  console.log(`   当前文件记录数: ${logManager.getCurrentRecordCount()}`);
  console.log(`   总记录数: ${logManager.getTotalRecordCount()}`);

  console.log('\n3. 测试文件分割...');
  const files = logManager.getFileList();
  console.log(`   文件数量: ${files.length}`);
  files.forEach((f, i) => {
    console.log(`   文件 ${i + 1}: ${f.file} - ${f.recordCount} 条记录, ${f.size} 字节`);
  });

  console.log('\n4. 测试 queryRecords()...');
  const result = await logManager.queryRecords({ limit: 10 });
  console.log(`   查询到 ${result.data.length} 条记录`);
  console.log(`   总记录数估计: ${result.total}`);
  console.log(`   有更多数据: ${result.hasMore}`);

  console.log('\n5. 测试按时间范围查询...');
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const result2 = await logManager.queryRecords({
    startTime: oneHourAgo.toISOString(),
    endTime: now.toISOString(),
    limit: 5
  });
  console.log(`   时间范围查询到 ${result2.data.length} 条记录`);

  console.log('\n6. 测试 exportReport() (CSV)...');
  const csvPath = path.join(testDir, 'export.csv');
  const csvResult = await logManager.exportReport({
    format: 'csv',
    outputPath: csvPath,
    includeProcesses: false
  });
  console.log(`   ✓ 导出 CSV 成功: ${csvResult.totalExported} 条记录`);
  console.log(`   文件大小: ${fs.statSync(csvPath).size} 字节`);

  console.log('\n7. 测试 exportReport() (JSON)...');
  const jsonPath = path.join(testDir, 'export.json');
  const jsonResult = await logManager.exportReport({
    format: 'json',
    outputPath: jsonPath
  });
  console.log(`   ✓ 导出 JSON 成功: ${jsonResult.totalExported} 条记录`);
  console.log(`   文件大小: ${fs.statSync(jsonPath).size} 字节`);

  console.log('\n8. 测试 stop()...');
  await logManager.stop();
  console.log('   ✓ 停止成功');

  console.log('\n9. 测试索引重建...');
  const logManager2 = new LogManager({
    logDir: testDir,
    baseName: 'test_log'
  });
  await logManager2.start();
  const files2 = logManager2.getFileList();
  console.log(`   重建索引后文件数: ${files2.length}`);
  console.log(`   重建索引后总记录数: ${logManager2.getTotalRecordCount()}`);
  await logManager2.stop();

  console.log('\n10. 测试 deleteOldFiles()...');
  await logManager2.start();
  for (let i = 0; i < 5; i++) {
    logManager2.addRecord({
      timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      cpu: { usage: 50 },
      memory: { usage: 50 },
      disk: { usage: 50 },
      network: { upMB: 0, downMB: 0 }
    });
  }
  await new Promise(resolve => setTimeout(resolve, 200));
  const deleted = await logManager2.deleteOldFiles(7);
  console.log(`   ✓ 删除了 ${deleted} 个旧文件`);
  await logManager2.stop();

  console.log('\n=== 所有测试通过! ===');
  console.log(`\n测试目录: ${testDir}`);
  console.log('你可以查看该目录下的文件结构');
}

testLogManager().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
