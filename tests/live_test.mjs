import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Mock Node-RED sandbox globals before importing src modules
globalThis.env = {
  get: (key) => {
    const store = {
      RUCKUS_HOST: process.env.RUCKUS_HOST || '192.168.88.181',
      RUCKUS_USER: process.env.RUCKUS_USER || 'admin',
      RUCKUS_PASS: process.env.RUCKUS_PASS || '', // 請在執行前設定環境變數或在此處填寫
      RUCKUS_ENABLE_UNBLOCK: 'true'
    };
    return store[key];
  }
};

const contextStore = {};
globalThis.context = {
  get: (key) => contextStore[key],
  set: (key, val) => { contextStore[key] = val; }
};

globalThis.node = {
  warn: (msg) => console.warn('[Node Warn]:', msg),
  error: (err) => console.error('[Node Error]:', err)
};

// Import Node-RED libs globally to match sandbox environment
import xml2js from 'xml2js';
import tls from 'tls';
globalThis.xml2js = xml2js;
globalThis.tls = tls;

// 2. Import the newly modularized API functions dynamically after setting globals
const { login, getActiveRogues, getBlockedRogues } = await import('../src/api.mjs');

async function runLiveTest() {
  const host = env.get('RUCKUS_HOST');
  const user = env.get('RUCKUS_USER');
  const pass = env.get('RUCKUS_PASS');

  if (!pass) {
    console.error('❌ 請先設定環境變數 RUCKUS_PASS，或在腳本中修改寫入密碼。');
    process.exit(1);
  }

  const mask = (str) => {
    if (!str) return 'empty';
    if (str.length <= 2) return '*'.repeat(str.length);
    return str[0] + '*'.repeat(str.length - 2) + str[str.length - 1];
  };
  console.log(`🔍 [Debug Config] HOST=${host}, USER=${user}, PASS=${mask(pass)} (length=${pass.length})`);

  console.log(`📡 正在連線至 Ruckus 控制器: https://${host}...`);
  try {
    console.log('🔑 1. 正在嘗試登入 (Login)...');
    await login();
    console.log('✅ 登入成功！已獲取 Cookie 與 CSRF Token。');

    console.log('🔍 2. 正在獲取 Active Rogues...');
    const active = await getActiveRogues();
    console.log(`✅ 成功獲取 Active Rogues! 數量: ${active.length}`);

    console.log('🔒 3. 正在獲取 Blocked Rogues...');
    const blocked = await getBlockedRogues();
    console.log(`✅ 成功獲取 Blocked Rogues! 數量: ${blocked.length}`);
    
    console.log('\n🎉 RUCKUS 實機 API 連線與解析測試全部通過！');
  } catch (err) {
    console.error('\n❌ 測試失敗，錯誤原因:', err.message || err);
    process.exit(1);
  }
}

runLiveTest();
