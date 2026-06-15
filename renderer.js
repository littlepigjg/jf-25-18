const { ipcRenderer } = require('electron');

let cpuMemoryChart;
let networkChart;
let historyChart;
let cpuData = [];
let memoryData = [];
let networkUpData = [];
let networkDownData = [];
let labels = [];
let maxDataPoints = 30;
let currentSort = 'cpu';
let currentProcesses = [];
let alertCount = 0;
let historyData = [];
let historyOffset = 0;
let historyHasMore = false;
let historyTotal = 0;
let currentFiles = [];

document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  bindEvents();
  ipcRenderer.send('get-thresholds');
  ipcRenderer.send('get-logging-status');
  ipcRenderer.send('get-alert-history');
  setDefaultDates();
});

function setDefaultDates() {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  document.getElementById('historyStartTime').value = formatDateTimeLocal(yesterday);
  document.getElementById('historyEndTime').value = formatDateTimeLocal(now);
  document.getElementById('exportStartTime').value = formatDateTimeLocal(yesterday);
  document.getElementById('exportEndTime').value = formatDateTimeLocal(now);
}

function formatDateTimeLocal(date) {
  return date.toISOString().slice(0, 16);
}

function initCharts() {
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 300
    },
    plugins: {
      legend: {
        display: true,
        position: 'top',
        labels: {
          color: '#94a3b8',
          font: { size: 12 }
        }
      }
    },
    scales: {
      x: {
        grid: {
          color: 'rgba(71, 85, 105, 0.3)'
        },
        ticks: {
          color: '#94a3b8',
          font: { size: 10 },
          maxRotation: 0,
          maxTicksLimit: 6
        }
      },
      y: {
        min: 0,
        max: 100,
        grid: {
          color: 'rgba(71, 85, 105, 0.3)'
        },
        ticks: {
          color: '#94a3b8',
          font: { size: 10 },
          callback: value => value + '%'
        }
      }
    }
  };

  const cpuMemoryCtx = document.getElementById('cpuMemoryChart').getContext('2d');
  cpuMemoryChart = new Chart(cpuMemoryCtx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'CPU 使用率',
          data: cpuData,
          borderColor: '#7c3aed',
          backgroundColor: 'rgba(124, 58, 237, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 4
        },
        {
          label: '内存使用率',
          data: memoryData,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 4
        }
      ]
    },
    options: chartOptions
  });

  const networkCtx = document.getElementById('networkChart').getContext('2d');
  networkChart = new Chart(networkCtx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: '上传 (MB/s)',
          data: networkUpData,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 4
        },
        {
          label: '下载 (MB/s)',
          data: networkDownData,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 4
        }
      ]
    },
    options: {
      ...chartOptions,
      scales: {
        ...chartOptions.scales,
        y: {
          ...chartOptions.scales.y,
          max: undefined,
          ticks: {
            color: '#94a3b8',
            font: { size: 10 },
            callback: value => value.toFixed(2) + ' MB/s'
          }
        }
      }
    }
  });

  const historyCtx = document.getElementById('historyChart').getContext('2d');
  historyChart = new Chart(historyCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'CPU 使用率',
          data: [],
          borderColor: '#7c3aed',
          backgroundColor: 'rgba(124, 58, 237, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 0
        },
        {
          label: '内存使用率',
          data: [],
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 0
        }
      ]
    },
    options: {
      ...chartOptions,
      plugins: {
        ...chartOptions.plugins,
        legend: {
          ...chartOptions.plugins.legend,
          display: true
        }
      }
    }
  });
}

function bindEvents() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
    });
  });

  document.getElementById('btnStartLog').addEventListener('click', () => {
    ipcRenderer.send('start-logging');
  });

  document.getElementById('btnStopLog').addEventListener('click', () => {
    ipcRenderer.send('stop-logging');
  });

  document.getElementById('btnExport').addEventListener('click', () => {
    openExportModal();
  });

  document.getElementById('btnSettings').addEventListener('click', () => {
    openSettings();
  });

  document.getElementById('btnCloseSettings').addEventListener('click', closeSettings);
  document.getElementById('btnCancelSettings').addEventListener('click', closeSettings);
  document.getElementById('btnSaveSettings').addEventListener('click', saveSettings);

  document.getElementById('btnCloseExport').addEventListener('click', closeExportModal);
  document.getElementById('btnCancelExport').addEventListener('click', closeExportModal);
  document.getElementById('btnConfirmExport').addEventListener('click', confirmExport);

  document.getElementById('btnCloseClean').addEventListener('click', closeCleanModal);
  document.getElementById('btnCancelClean').addEventListener('click', closeCleanModal);
  document.getElementById('btnConfirmClean').addEventListener('click', confirmClean);

  document.getElementById('btnQueryHistory').addEventListener('click', queryHistory);
  document.getElementById('btnLoadMore').addEventListener('click', loadMoreHistory);

  document.getElementById('btnRefreshFiles').addEventListener('click', refreshFiles);
  document.getElementById('btnCleanOld').addEventListener('click', openCleanModal);

  document.getElementById('exportRange').addEventListener('change', (e) => {
    const isCustom = e.target.value === 'custom';
    document.getElementById('customRangeContainer').style.display = isCustom ? 'flex' : 'none';
    document.getElementById('customRangeEndContainer').style.display = isCustom ? 'flex' : 'none';
    updateExportInfo();
  });

  document.getElementById('exportFormat').addEventListener('change', updateExportInfo);
  document.getElementById('exportIncludeProcesses').addEventListener('change', updateExportInfo);

  document.querySelectorAll('.sort-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sort-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentSort = tab.dataset.sort;
      renderProcesses(currentProcesses);
    });
  });

  document.getElementById('cpuThreshold').addEventListener('input', (e) => {
    document.getElementById('cpuThresholdValue').textContent = e.target.value + '%';
  });

  document.getElementById('memoryThreshold').addEventListener('input', (e) => {
    document.getElementById('memoryThresholdValue').textContent = e.target.value + '%';
  });

  document.getElementById('diskThreshold').addEventListener('input', (e) => {
    document.getElementById('diskThresholdValue').textContent = e.target.value + '%';
  });

  document.getElementById('logInterval').addEventListener('input', (e) => {
    document.getElementById('logIntervalValue').textContent = e.target.value + '秒';
  });

  document.getElementById('maxFileSize').addEventListener('input', (e) => {
    document.getElementById('maxFileSizeValue').textContent = e.target.value + ' MB';
  });
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `tab-${tab}`);
  });

  if (tab === 'files') {
    refreshFiles();
  }
}

ipcRenderer.on('system-data', (event, data) => {
  updateStats(data);
  updateCharts(data);
  currentProcesses = data.topProcesses;
  renderProcesses(currentProcesses);
});

ipcRenderer.on('alerts', (event, alerts) => {
  alerts.forEach(alert => {
    addAlert(alert);
  });
  
  if (alerts.some(a => a.level === 'critical')) {
    showToast('error', '严重告警：系统资源严重不足！');
  } else if (alerts.length > 0) {
    showToast('warning', '告警：系统资源使用率过高');
  }
});

ipcRenderer.on('alert-history', (event, history) => {
  const alertList = document.getElementById('alertList');
  alertList.innerHTML = '';
  
  if (history.length === 0) {
    alertList.innerHTML = '<div class="empty-state">暂无告警</div>';
    return;
  }
  
  history.slice(0, 50).forEach(alert => {
    addAlertItem(alert);
  });
  
  alertCount = history.length;
  document.getElementById('alertCount').textContent = alertCount;
});

ipcRenderer.on('logging-status', (event, status) => {
  updateLoggingStatus(status);
  if (status.files && status.files.length > 0) {
    currentFiles = status.files;
    renderFiles(status.files);
  }
});

ipcRenderer.on('log-file-created', (event, info) => {
  showToast('info', `新建日志文件: ${info.file}`);
  ipcRenderer.send('get-logging-status');
});

ipcRenderer.on('log-flushed', (event, info) => {
  ipcRenderer.send('get-logging-status');
});

ipcRenderer.on('thresholds-data', (event, thresholds) => {
  document.getElementById('cpuThreshold').value = thresholds.cpu;
  document.getElementById('cpuThresholdValue').textContent = thresholds.cpu + '%';
  document.getElementById('memoryThreshold').value = thresholds.memory;
  document.getElementById('memoryThresholdValue').textContent = thresholds.memory + '%';
  document.getElementById('diskThreshold').value = thresholds.disk;
  document.getElementById('diskThresholdValue').textContent = thresholds.disk + '%';
  
  if (thresholds.splitStrategy) {
    document.getElementById('splitStrategy').value = thresholds.splitStrategy;
  }
  if (thresholds.maxFileSize) {
    const sizeMB = Math.round(thresholds.maxFileSize / 1024 / 1024);
    document.getElementById('maxFileSize').value = sizeMB;
    document.getElementById('maxFileSizeValue').textContent = sizeMB + ' MB';
  }
});

ipcRenderer.on('thresholds-updated', (event, thresholds) => {
  showToast('success', '设置已保存');
  closeSettings();
});

ipcRenderer.on('export-success', (event, data) => {
  showToast('success', `已导出 ${data.count} 条记录到: ${data.file}`);
  closeExportModal();
});

ipcRenderer.on('export-error', (event, data) => {
  showToast('error', `导出失败: ${data.error}`);
});

ipcRenderer.on('history-result', (event, result) => {
  if (result.error) {
    showToast('error', `查询失败: ${result.error}`);
    return;
  }
  
  if (historyOffset === 0) {
    historyData = [];
  }
  
  historyData.push(...result.data);
  historyHasMore = result.hasMore;
  historyTotal = result.total;
  
  renderHistoryResult(result.data, historyOffset === 0);
  updateHistorySummary();
  updateHistoryChart();
  
  document.getElementById('btnLoadMore').disabled = !result.hasMore;
});

ipcRenderer.on('log-files', (event, files) => {
  currentFiles = files;
  renderFiles(files);
});

ipcRenderer.on('old-logs-deleted', (event, result) => {
  showToast('success', `已删除 ${result.count} 个旧日志文件`);
  closeCleanModal();
  refreshFiles();
});

function updateStats(data) {
  document.getElementById('cpuValue').textContent = data.cpu.usage.toFixed(1);
  document.getElementById('cpuCores').textContent = data.cpu.cores;
  document.getElementById('cpuBar').style.width = data.cpu.usage + '%';
  
  document.getElementById('memoryValue').textContent = data.memory.usage.toFixed(1);
  document.getElementById('memoryUsed').textContent = formatBytes(data.memory.used);
  document.getElementById('memoryTotal').textContent = formatBytes(data.memory.total);
  document.getElementById('memoryBar').style.width = data.memory.usage + '%';
  
  document.getElementById('diskValue').textContent = data.disk.usage.toFixed(1);
  document.getElementById('diskUsed').textContent = formatBytes(data.disk.used);
  document.getElementById('diskTotal').textContent = formatBytes(data.disk.total);
  document.getElementById('diskBar').style.width = data.disk.usage + '%';
  
  document.getElementById('networkUp').textContent = data.network.upMB.toFixed(2);
  document.getElementById('networkDown').textContent = data.network.downMB.toFixed(2);
}

function updateCharts(data) {
  const time = new Date(data.timestamp);
  const timeStr = time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  
  labels.push(timeStr);
  cpuData.push(data.cpu.usage);
  memoryData.push(data.memory.usage);
  networkUpData.push(data.network.upMB);
  networkDownData.push(data.network.downMB);
  
  if (labels.length > maxDataPoints) {
    labels.shift();
    cpuData.shift();
    memoryData.shift();
    networkUpData.shift();
    networkDownData.shift();
  }
  
  cpuMemoryChart.update('none');
  networkChart.update('none');
}

function renderProcesses(processes) {
  const processList = document.getElementById('processList');
  
  if (!processes || processes.length === 0) {
    processList.innerHTML = '<div class="loading">加载中...</div>';
    return;
  }

  const sorted = [...processes].sort((a, b) => {
    return currentSort === 'cpu' ? b.cpu - a.cpu : b.mem - a.mem;
  });

  processList.innerHTML = sorted.map((p, index) => {
    const cpuColor = p.cpu >= 50 ? 'var(--danger-color)' : p.cpu >= 20 ? 'var(--warning-color)' : 'var(--text-primary)';
    const memColor = p.mem >= 50 ? 'var(--danger-color)' : p.mem >= 20 ? 'var(--warning-color)' : 'var(--text-primary)';
    
    return `
      <div class="process-item">
        <div class="process-rank">${index + 1}</div>
        <div class="process-icon">📄</div>
        <div class="process-name">${escapeHtml(p.name)}
          <span class="process-pid">PID: ${p.pid}</span>
        </div>
        <div class="process-stats">
          <div class="process-stat">
            <div class="process-stat-label">CPU</div>
            <div class="process-stat-value" style="color: ${cpuColor}">${p.cpu.toFixed(1)}%</div>
          </div>
          <div class="process-stat">
            <div class="process-stat-label">内存</div>
            <div class="process-stat-value" style="color: ${memColor}">${p.mem.toFixed(1)}%</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function addAlert(alert) {
  alertCount++;
  document.getElementById('alertCount').textContent = alertCount;
  
  const alertList = document.getElementById('alertList');
  const emptyState = alertList.querySelector('.empty-state');
  if (emptyState) emptyState.remove();
  
  addAlertItem(alert, true);
  
  const items = alertList.querySelectorAll('.alert-item');
  if (items.length > 50) {
    items[items.length - 1].remove();
  }
}

function addAlertItem(alert, prepend = false) {
  const alertList = document.getElementById('alertList');
  
  const icon = alert.level === 'critical' ? '🚨' : '⚠️';
  const time = new Date(alert.timestamp).toLocaleString('zh-CN');
  
  const item = document.createElement('div');
  item.className = `alert-item alert-level-${alert.level}`;
  item.innerHTML = `
    <div class="alert-icon">${icon}</div>
    <div class="alert-content">
      <div class="alert-message">${escapeHtml(alert.message)}</div>
      <div class="alert-time">${time}</div>
    </div>
  `;
  
  if (prepend) {
    alertList.insertBefore(item, alertList.firstChild);
  } else {
    alertList.appendChild(item);
  }
}

function updateLoggingStatus(status) {
  const btnStart = document.getElementById('btnStartLog');
  const btnStop = document.getElementById('btnStopLog');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  
  if (status.running) {
    btnStart.disabled = true;
    btnStop.disabled = false;
    statusDot.classList.add('active');
    const total = status.totalRecords || status.records || 0;
    statusText.textContent = `记录中 (${total}条)`;
  } else {
    btnStart.disabled = false;
    btnStop.disabled = true;
    statusDot.classList.remove('active');
    if (status.records || status.totalRecords) {
      statusText.textContent = `已记录 ${status.totalRecords || status.records} 条`;
    } else {
      statusText.textContent = '待机中';
    }
  }
}

function queryHistory() {
  const startTime = document.getElementById('historyStartTime').value;
  const endTime = document.getElementById('historyEndTime').value;
  
  if (!startTime || !endTime) {
    showToast('warning', '请选择开始和结束时间');
    return;
  }
  
  historyOffset = 0;
  historyData = [];
  
  ipcRenderer.send('query-history', {
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    limit: 100,
    offset: 0
  });
}

function loadMoreHistory() {
  const startTime = document.getElementById('historyStartTime').value;
  const endTime = document.getElementById('historyEndTime').value;
  
  historyOffset += 100;
  
  ipcRenderer.send('query-history', {
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    limit: 100,
    offset: historyOffset
  });
}

function renderHistoryResult(data, reset = false) {
  const tbody = document.getElementById('historyTableBody');
  
  if (reset && data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">该时间范围内没有数据</td></tr>';
    return;
  }
  
  if (reset) {
    tbody.innerHTML = '';
  }
  
  data.forEach(d => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${new Date(d.timestamp).toLocaleString('zh-CN')}</td>
      <td style="color: ${getUsageColor(d.cpu.usage)}">${d.cpu.usage.toFixed(1)}%</td>
      <td style="color: ${getUsageColor(d.memory.usage)}">${d.memory.usage.toFixed(1)}%</td>
      <td style="color: ${getUsageColor(d.disk.usage)}">${d.disk.usage.toFixed(1)}%</td>
      <td>${d.network.upMB.toFixed(2)}</td>
      <td>${d.network.downMB.toFixed(2)}</td>
    `;
    tbody.appendChild(row);
  });
}

function updateHistorySummary() {
  if (historyData.length === 0) {
    document.getElementById('historySummary').innerHTML = '';
    return;
  }
  
  const cpuValues = historyData.map(d => d.cpu.usage);
  const memValues = historyData.map(d => d.memory.usage);
  const diskValues = historyData.map(d => d.disk.usage);
  
  const summary = {
    cpu: {
      avg: (cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length).toFixed(1),
      max: Math.max(...cpuValues).toFixed(1),
      min: Math.min(...cpuValues).toFixed(1)
    },
    memory: {
      avg: (memValues.reduce((a, b) => a + b, 0) / memValues.length).toFixed(1),
      max: Math.max(...memValues).toFixed(1),
      min: Math.min(...memValues).toFixed(1)
    },
    disk: {
      avg: (diskValues.reduce((a, b) => a + b, 0) / diskValues.length).toFixed(1),
      max: Math.max(...diskValues).toFixed(1),
      min: Math.min(...diskValues).toFixed(1)
    }
  };
  
  document.getElementById('historySummary').innerHTML = `
    <div class="summary-item">
      <span class="summary-label">记录数</span>
      <span class="summary-value">${historyData.length} / ${historyTotal}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">CPU 平均/最高</span>
      <span class="summary-value">${summary.cpu.avg}% / ${summary.cpu.max}%</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">内存 平均/最高</span>
      <span class="summary-value">${summary.memory.avg}% / ${summary.memory.max}%</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">磁盘 平均/最高</span>
      <span class="summary-value">${summary.disk.avg}% / ${summary.disk.max}%</span>
    </div>
  `;
}

function updateHistoryChart() {
  const chartData = historyData.slice(-100);
  historyChart.data.labels = chartData.map(d => {
    const dt = new Date(d.timestamp);
    return dt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  });
  historyChart.data.datasets[0].data = chartData.map(d => d.cpu.usage);
  historyChart.data.datasets[1].data = chartData.map(d => d.memory.usage);
  historyChart.update('none');
}

function getUsageColor(usage) {
  if (usage >= 90) return 'var(--danger-color)';
  if (usage >= 70) return 'var(--warning-color)';
  return 'var(--text-primary)';
}

function refreshFiles() {
  ipcRenderer.send('get-log-files');
}

function renderFiles(files) {
  const tbody = document.getElementById('filesTableBody');
  const summary = document.getElementById('filesSummary');
  
  if (files.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">暂无日志文件，请先启动记录</td></tr>';
    summary.innerHTML = '';
    return;
  }
  
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const totalRecords = files.reduce((sum, f) => sum + f.recordCount, 0);
  
  summary.innerHTML = `
    <span>共 <strong>${files.length}</strong> 个文件</span>
    <span><strong>${formatBytes(totalSize)}</strong> 磁盘空间</span>
    <span><strong>${totalRecords}</strong> 条记录</span>
  `;
  
  tbody.innerHTML = files.map(f => `
    <tr>
      <td>${escapeHtml(f.file)}</td>
      <td>${new Date(f.startTime).toLocaleString('zh-CN')}</td>
      <td>${new Date(f.endTime).toLocaleString('zh-CN')}</td>
      <td>${f.recordCount.toLocaleString()}</td>
      <td>${formatBytes(f.size)}</td>
    </tr>
  `).join('');
}

function openSettings() {
  ipcRenderer.send('get-thresholds');
  document.getElementById('settingsModal').classList.add('active');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('active');
}

function saveSettings() {
  const thresholds = {
    cpu: parseInt(document.getElementById('cpuThreshold').value),
    memory: parseInt(document.getElementById('memoryThreshold').value),
    disk: parseInt(document.getElementById('diskThreshold').value),
    splitStrategy: document.getElementById('splitStrategy').value,
    maxFileSize: parseInt(document.getElementById('maxFileSize').value) * 1024 * 1024
  };
  
  const logIntervalSec = parseInt(document.getElementById('logInterval').value);
  
  ipcRenderer.send('update-thresholds', thresholds);
  ipcRenderer.send('set-log-interval', logIntervalSec * 1000);
}

function openExportModal() {
  updateExportInfo();
  document.getElementById('exportModal').classList.add('active');
}

function closeExportModal() {
  document.getElementById('exportModal').classList.remove('active');
}

function updateExportInfo() {
  const range = document.getElementById('exportRange').value;
  const format = document.getElementById('exportFormat').value;
  const includeProcesses = document.getElementById('exportIncludeProcesses').checked;
  
  let estimatedSize = '未知';
  let recordCount = currentFiles.reduce((sum, f) => sum + f.recordCount, 0);
  
  if (range === 'today') {
    recordCount = Math.round(recordCount * 0.1);
  } else if (range === 'week') {
    recordCount = Math.round(recordCount * 0.5);
  }
  
  const sizePerRecord = includeProcesses ? 1.5 : 0.5;
  const estBytes = recordCount * sizePerRecord * 1024;
  estimatedSize = formatBytes(estBytes);
  
  const formatName = format === 'csv' ? 'CSV（推荐，打开速度快）' : 'JSON（完整数据）';
  
  document.getElementById('exportInfo').innerHTML = `
    导出格式: <strong>${formatName}</strong><br>
    预计记录数: <strong>${recordCount.toLocaleString()}</strong> 条<br>
    预计文件大小: <strong>${estimatedSize}</strong><br>
    ${format === 'csv' && includeProcesses ? '<span class="text-danger">注意：包含进程数据会增加导出时间</span>' : ''}
  `;
}

function confirmExport() {
  const range = document.getElementById('exportRange').value;
  const format = document.getElementById('exportFormat').value;
  const includeProcesses = document.getElementById('exportIncludeProcesses').checked;
  
  let startTime = null;
  let endTime = null;
  
  const now = new Date();
  
  if (range === 'today') {
    startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    endTime = now.toISOString();
  } else if (range === 'week') {
    startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    endTime = now.toISOString();
  } else if (range === 'custom') {
    const startVal = document.getElementById('exportStartTime').value;
    const endVal = document.getElementById('exportEndTime').value;
    if (!startVal || !endVal) {
      showToast('warning', '请选择自定义时间范围');
      return;
    }
    startTime = new Date(startVal).toISOString();
    endTime = new Date(endVal).toISOString();
  }
  
  ipcRenderer.send('export-report', {
    format,
    startTime,
    endTime,
    includeProcesses
  });
  
  showToast('info', '正在导出，请稍候...');
}

function openCleanModal() {
  document.getElementById('cleanModal').classList.add('active');
}

function closeCleanModal() {
  document.getElementById('cleanModal').classList.remove('active');
}

function confirmClean() {
  const days = parseInt(document.getElementById('cleanDays').value);
  if (confirm(`确定要删除 ${days} 天前的所有日志文件吗？此操作不可撤销。`)) {
    ipcRenderer.send('delete-old-logs', days);
  }
}

function showToast(type, message) {
  const container = document.getElementById('toastContainer');
  
  const icons = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️'
  };
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${icons[type]}</div>
    <div class="toast-message">${escapeHtml(message)}</div>
  `;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'toastIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
