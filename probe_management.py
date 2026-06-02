import asyncio
import json
import sys
from contextlib import suppress

try:
    from aioruckus import AjaxSession
except ImportError:
    print("❌ 找不到 aioruckus 庫。請先執行: pip install aioruckus")
    sys.exit(1)

# ==========================================
# ⬅️ 請填入您的 Ruckus Unleashed 帳號與密碼
# ==========================================
RUCKUS_HOST = "192.168.88.181"
RUCKUS_USER = "YOUR_USERNAME"      # ⬅️ 請填入您的帳號
RUCKUS_PASS = "YOUR_PASSWORD"      # ⬅️ 請填入您的密碼

async def test_ruckus():
    if RUCKUS_USER == "YOUR_USERNAME" or RUCKUS_PASS == "YOUR_PASSWORD":
        print("⚠️  請先編輯此腳本，填入您的 RUCKUS_USER 與 RUCKUS_PASS。")
        return

    print(f"# 正在連線至 {RUCKUS_HOST}...")
    try:
        async with AjaxSession.async_create(RUCKUS_HOST, RUCKUS_USER, RUCKUS_PASS) as session:
            api = session.api
            print("✅ 成功登入！開始獲取詳細資訊...\n")

            # 1. 系統資訊 (System Info)
            print("== 1. 系統資訊 (System Info) ==")
            try:
                sys_info = await api.get_system_info()
                print(json.dumps(sys_info, indent=2, default=str)[:1000])
            except Exception as e:
                print(f"❌ 獲取系統資訊失敗: {e}")

            # 2. AP 列表 (AP List)
            print("\n== 2. AP 列表 (AP List) ==")
            try:
                aps = await api.get_aps()
                print(f"總共發現 {len(aps)} 台 AP:")
                print(json.dumps(aps[:3], indent=2, default=str))  # 僅列出前 3 台以防洗版
            except Exception as e:
                print(f"❌ 獲取 AP 列表失敗: {e}")

            # 3. 作用中用戶端 (Active Clients)
            print("\n== 3. 作用中用戶端 (Active Clients) ==")
            try:
                clients = await api.get_active_clients()
                print(f"目前有 {len(clients)} 個作用中用戶端:")
                print(json.dumps(clients[:3], indent=2, default=str))  # 僅列出前 3 個
            except Exception as e:
                print(f"❌ 獲取用戶端列表失敗: {e}")

            # 4. WLAN (無線網路)
            print("\n== 4. 無線網路列表 (WLAN List) ==")
            try:
                wlans = await api.get_wlans()
                print(f"總共配置 {len(wlans)} 個 WLAN 網路:")
                print(json.dumps(wlans[:3], indent=2, default=str))  # 僅列出前 3 個
            except Exception as e:
                print(f"❌ 獲取 WLAN 列表失敗: {e}")

            # 5. 系統日誌 (Syslog)
            print("\n== 5. 系統日誌 (Syslog - 僅顯示前 300 字) ==")
            try:
                syslog = await api.get_syslog()
                print(syslog[:300])
            except Exception as e:
                print(f"❌ 獲取 Syslog 失敗: {e}")

    except Exception as e:
        print(f"❌ 連線或登入失敗: {e}")

if __name__ == "__main__":
    asyncio.run(test_ruckus())
