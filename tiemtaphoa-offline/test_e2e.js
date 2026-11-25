const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

// Simulate browser/Cocos global environment
global.window = global;
global.self = global;
global.cc = {
    _RF: { push() {}, pop() {} },
    sys: {
        localStorage: (() => {
            const m = {};
            return {
                getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
                setItem: (k, v) => { m[k] = String(v); },
                removeItem: (k) => { delete m[k]; }
            };
        })()
    }
};

// Load game's exact along.js, bytebuffer.js, protobuf.js
vm.runInThisContext(fs.readFileSync("/home/antigravity/work/tiemtaphoa/decrypted/along.js", "utf8"), { filename: "along.js" });
vm.runInThisContext(fs.readFileSync("/home/antigravity/work/tiemtaphoa/decrypted/bytebuffer.js", "utf8"), { filename: "bytebuffer.js" });
vm.runInThisContext(fs.readFileSync("/home/antigravity/work/tiemtaphoa/decrypted/protobuf.js", "utf8"), { filename: "protobuf.js" });

// Build GameMsg.proto via game's exact ProtoBuf.protoFromString
const protoText = fs.readFileSync("/home/antigravity/work/tiemtaphoa/extracted_data/GameMsg.proto", "utf8");
const builder = window.ProtoBuf.protoFromString(protoText);

// Parse Protocol.js to register every single C2S and S2C protocol exactly like the game does
const protoJs = fs.readFileSync("/home/antigravity/work/tiemtaphoa/mods_core/Protocol.js", "utf8");
const consts = {};
for (const m of protoJs.matchAll(/t\.([A-Z0-9_]+)\s*=\s*(\d+);/g)) {
    consts[m[1]] = Number(m[2]);
}
function toRecvProtocol(e) {
    return e < 1e6 ? e % 1e4 : e < 2e6 ? e : e - 1e6;
}
const cmdList = {};
const resvCmdList = {};
const messages = {};
const prefix = "com.zy.msg.GameMsg.";

for (const m of protoJs.matchAll(/this\.addC2Scmd\(t\.([A-Z0-9_]+),\s*"([^"]+)"(?:,\s*"([^"]+)")?(?:,\s*"[^"]*")?(?:,\s*(-?\d+))?\)/g)) {
    const id = consts[m[1]];
    const cm = m[2];
    const sm = m[3];
    const overrideId = m[4] ? Number(m[4]) : -1;
    const smMsgId = toRecvProtocol(overrideId !== -1 ? overrideId : id);
    cmdList[id] = { cmMethod: cm, smMethod: sm, smMsgId };
    if (cm && !messages[prefix + cm]) messages[prefix + cm] = builder.build(prefix + cm);
    if (sm) {
        if (!messages[prefix + sm]) messages[prefix + sm] = builder.build(prefix + sm);
        resvCmdList[smMsgId] = { smMethod: sm };
    }
}
for (const m of protoJs.matchAll(/this\.addS2Ccmd\(t\.([A-Z0-9_]+),\s*"([^"]+)"/g)) {
    const id = consts[m[1]];
    const sm = m[2];
    const smMsgId = toRecvProtocol(id);
    cmdList[id] = { smMethod: sm, smMsgId };
    if (!messages[prefix + sm]) messages[prefix + sm] = builder.build(prefix + sm);
    resvCmdList[smMsgId] = { smMethod: sm };
}

global.__OFFLINE_PROTOBUF_MGR__ = {
    cmdList,
    resvCmdList,
    messages,
    getMsg(id, isSend, returnClass) {
        const entry = isSend ? cmdList[id] : resvCmdList[id];
        if (!entry) return null;
        const name = isSend ? entry.cmMethod : entry.smMethod;
        if (!name) return null;
        const cls = messages[prefix + name];
        if (!cls) return null;
        return returnClass ? cls : new cls();
    }
};

// Load offline-server.js
require("./offline-server.js");
const srv = global.__GCXUA_OFFLINE_SERVER__;

async function runTests() {
    console.log("1. Testing HTTP endpoints...");
    function post(url, obj) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", url, true);
            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4) {
                    if (xhr.status === 200) resolve(JSON.parse(xhr.responseText));
                    else reject(new Error("HTTP " + xhr.status));
                }
            };
            xhr.send("param=" + encodeURIComponent(JSON.stringify(obj || {})));
        });
    }

    const langRes = await post("https://login-sg-71.pogohopper.com/Web/languagePackage", { language: "vi_vn" });
    assert.strictEqual(langRes.result, 0);

    const updRes = await post("https://login-sg-71.pogohopper.com/Web/packageUpdate", {});
    assert.strictEqual(updRes.result, 0);
    assert.strictEqual(updRes.updateLevel, 0);
    assert.strictEqual(updRes.hotPackUpdateLevel, 0);

    const slRes = await post("https://login-sg-71.pogohopper.com/Web/packageServerList", { openId: "test_user" });
    assert.strictEqual(slRes.result, 0);
    assert.strictEqual(slRes.allowLogin, true);
    const servers = JSON.parse(slRes.serverList);
    assert.strictEqual(servers.length, 1);
    assert.strictEqual(servers[0].serverId, 1);

    const rnRes = await post(servers[0].url + "/getRandomName", { sex: 1 });
    assert.strictEqual(rnRes.result, 0);
    assert.ok(rnRes.name.length > 0);

    const login1 = await post(servers[0].url + "/login", { openId: "test_user", serverId: 1 });
    assert.strictEqual(login1.result, 0);
    assert.strictEqual(login1.hasRole, false);
    const uid = login1.userId;

    const createRes = await post(servers[0].url + "/createRole", { nickName: "Tiệm Tạp Hóa 9X", sex: 1, headId: 10001 });
    assert.strictEqual(createRes.result, 0);
    assert.strictEqual(createRes.nickName, "Tiệm Tạp Hóa 9X");

    const login2 = await post(servers[0].url + "/login", { openId: "test_user", serverId: 1 });
    assert.strictEqual(login2.result, 0);
    assert.strictEqual(login2.hasRole, true);
    assert.strictEqual(login2.address, "127.0.0.1");
    console.log("   HTTP PASS! userId=" + uid + " nickName=" + login2.nickName);

    console.log("2. Testing WebSocket + Protobuf Login Sync...");
    const ws = new WebSocket("ws://" + login2.address + ":" + login2.port);
    const received = [];
    await new Promise((resolve) => {
        ws.onopen = resolve;
    });

    ws.onmessage = (evt) => {
        const u8 = new Uint8Array(evt.data);
        const header = (u8[0] << 8) | u8[1];
        const totalLen = ((u8[2] << 24) >>> 0) + (u8[3] << 16) + (u8[4] << 8) + u8[5];
        const recvMsgId = (((u8[6] << 24) >>> 0) + (u8[7] << 16) + (u8[8] << 8) + u8[9]) | 0;
        assert.strictEqual(header, 29099);
        assert.strictEqual(totalLen, u8.length);
        const MsgClass = global.__OFFLINE_PROTOBUF_MGR__.getMsg(recvMsgId, false, true);
        assert.ok(MsgClass, "Missing S2C MsgClass for " + recvMsgId);
        const decoded = MsgClass.decode(u8.subarray(18));
        received.push({ recvMsgId, decoded });
    };

    function sendC2S(cmdId, obj) {
        const ReqClass = global.__OFFLINE_PROTOBUF_MGR__.getMsg(cmdId, true, true);
        const inst = new ReqClass(obj || {});
        const enc = inst.encode();
        const bodyLen = enc.limit - (enc.offset || 0);
        const totalLen = 18 + bodyLen;
        const buf = new ArrayBuffer(totalLen);
        const u8 = new Uint8Array(buf);
        u8[0] = (29099 >>> 8) & 0xff;
        u8[1] = 29099 & 0xff;
        u8[2] = (totalLen >>> 24) & 0xff;
        u8[3] = (totalLen >>> 16) & 0xff;
        u8[4] = (totalLen >>> 8) & 0xff;
        u8[5] = totalLen & 0xff;
        u8[6] = (cmdId >>> 24) & 0xff;
        u8[7] = (cmdId >>> 16) & 0xff;
        u8[8] = (cmdId >>> 8) & 0xff;
        u8[9] = cmdId & 0xff;
        const lv = window.Long.fromNumber(uid);
        u8[10] = (lv.high >>> 24) & 0xff;
        u8[11] = (lv.high >>> 16) & 0xff;
        u8[12] = (lv.high >>> 8) & 0xff;
        u8[13] = lv.high & 0xff;
        u8[14] = (lv.low >>> 24) & 0xff;
        u8[15] = (lv.low >>> 16) & 0xff;
        u8[16] = (lv.low >>> 8) & 0xff;
        u8[17] = lv.low & 0xff;
        for (let i = 0; i < bodyLen; i++) u8[18 + i] = enc.view[(enc.offset || 0) + i];
        ws.send(buf);
    }

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    sendC2S(10101, { userId: uid, openId: "test_user", clientVer: "3.7.1", langType: "vi_vn", phonePlatform: 1 });
    await wait(120);

    const recvIds = received.map((x) => x.recvMsgId);
    for (const reqId of [101, 152, 104, 105, 106, 111, 5851, 401, 501, 4301, 4201, 601, 1201, 1209, 301, 4851, 5601, 103]) {
        assert.ok(recvIds.includes(reqId), "Missing login sync msgId: " + reqId);
    }
    const completeSync = received.find((x) => x.recvMsgId === 1209);
    assert.ok(completeSync && completeSync.decoded.taskId.includes(2201101), "Starter business task 2201101 must be in completeTaskIds (1209)!");
    const customerSync = received.find((x) => x.recvMsgId === 4601);
    assert.ok(customerSync && customerSync.decoded.customerList.length === 57, "Expected 57 unlocked customers (108001..108057) in 4601, got " + (customerSync ? customerSync.decoded.customerList.length : 0));
    assert.strictEqual(customerSync.decoded.customerList[0].customerId, 108001);
    assert.strictEqual(customerSync.decoded.customerList[0].status, 2);
    const taskSync = received.find((x) => x.recvMsgId === 1201);
    const taskIds = taskSync ? taskSync.decoded.dataList.map((t) => t.taskId) : [];
    assert.ok(taskIds.includes(2300001) && taskIds.includes(2300041), "Expected all 41 GuideBook tasks (2300001..2300041) in 1201");
    const wsSync = received.find((x) => x.recvMsgId === 5601);
    assert.ok(wsSync && wsSync.decoded.workshopData.workshopConfig && wsSync.decoded.workshopData.workshopConfig.id === 1, "Expected valid workshopConfig.id=1 in 5601");
    console.log("   Login Sync PASS! Received " + received.length + " valid protobuf packets (incl. 2201101, 57 customers, 41 GuideBook tasks & WorkshopConfig) ending with smInitDataEnd(103).");

    console.log("3. Testing Core Gameplay Actions (Breakfast Stall, Tasks, Customers, Workshop, Heroes, Beauties)...");
    received.length = 0;
    sendC2S(20102, {}); // Ping
    sendC2S(20133, {}); // ConfigVersion
    sendC2S(20403, { buildingId: 15101, upgradeNum: 19 }); // Upgrade Breakfast Stall 1 -> 20
    sendC2S(20402, { buildingId: 15102, upgradeNum: 1 }); // Open Grocery Store (Small Shop)
    sendC2S(20424, { buildingId: 15101, handleType: 1, itemId: 10101 }); // Serve customer #1
    sendC2S(20424, { buildingId: 15101, handleType: 1, itemId: 10101 }); // Serve customer #2
    sendC2S(20424, { buildingId: 15101, handleType: 1, itemId: 10101 }); // Serve customer #3
    sendC2S(20428, { buildingId: 15101, handleType: 1 }); // Handle detail
    sendC2S(24603, { customerId: 108001 }); // S_CUSTOMER_UNLOCK
    sendC2S(24604, { customerId: 108001 }); // S_CUSTOMER_UNLOCK_REWARD
    sendC2S(25602, { isBackend: false }); // Workshop upgrade
    sendC2S(25611, {}); // Workshop info
    sendC2S(20503, { patronsId: 102210, times: 5 }); // Upgrade Hero
    sendC2S(24303, { beautyId: 103201 }); // Upgrade Beauty
    sendC2S(20108, {}); // Upgrade Identity Title
    sendC2S(21205, { taskId: 200001 }); // Claim Task #1
    sendC2S(21205, { taskId: 2201102 }); // Unlock Breakfast business 10102 (type=22)
    sendC2S(20304, {}); // Claim All Mail
    sendC2S(24852, {}); // Daily Sign-in
    sendC2S(20135, { key: "ALLHERO" }); // Exchange Code
    sendC2S(25852, { guideId: 101002, param: "" }); // Guide Record
    sendC2S(29359, {}); // VN Save Param
    await wait(120);

    const actionIds = new Set(received.map((x) => x.recvMsgId));
    for (const id of [102, 133, 403, 402, 424, 428, 4602, 4603, 4604, 5602, 5611, 503, 4303, 108, 1205, 1209, 304, 4852, 135, 5852, 9359]) {
        assert.ok(actionIds.has(id), "Missing response for recvMsgId: " + id);
    }
    const detailPkt = received.find((x) => x.recvMsgId === 428);
    assert.ok(detailPkt && detailPkt.decoded.details.length === 1 && detailPkt.decoded.details[0].num === 3, "Expected 3 served 10101 items in 428");
    const st = srv.getState("test_user");
    assert.strictEqual(st.buildings[15101].level, 20);
    assert.strictEqual(st.buildingServeCounts[15101], 3);
    assert.strictEqual(st.customers[108001].status, 3);
    assert.ok(st.completeTaskIds.includes(2201101) && st.completeTaskIds.includes(2201102), "2201101 & 2201102 should be completed");
    assert.strictEqual(st.workshop.sectionProgress, 2);
    assert.ok(st.buildings[15102], "15102 should be unlocked");
    assert.strictEqual(st.heroes[102210].level, 15);
    assert.strictEqual(st.titleId, 2);
    assert.strictEqual(Object.keys(st.heroes).length, 6);
    console.log("   Gameplay Actions PASS! Building 15101 Lv=" + st.buildings[15101].level + ", Served=" + st.buildingServeCounts[15101] + ", Workshop=" + st.workshop.sectionProgress + ", Heroes=" + Object.keys(st.heroes).length);

    console.log("4. Testing Auto-Schema Fallback on unhandled C2S protocols...");
    received.length = 0;
    const sampleUnhandled = [24400, 24001, 24003, 25902, 20440, 24210, 20605, 21011, 20210, 25502];
    for (const cid of sampleUnhandled) {
        if (cmdList[cid] && cmdList[cid].cmMethod && cmdList[cid].smMethod) {
            const ReqC = global.__OFFLINE_PROTOBUF_MGR__.getMsg(cid, true, true);
            sendC2S(cid, srv.buildDefaultMessageObj(ReqC, {}));
        }
    }
    await wait(100);
    assert.strictEqual(received.length, sampleUnhandled.length, "Expected all fallback responses");
    console.log("   Auto-Schema Fallback PASS! (" + received.length + "/" + sampleUnhandled.length + " decoded cleanly)");

    console.log("5. Testing Fix v3 (.manifest HTTP + Runtime Patches for RemoteResMgr/UIMgr/BuildingBaseView)...");
    const manifestRes = srv.handleHttpRequest("GET", "https://cdn-sg-vn.pogohopper.com/71001001/3.7.1.82/assetsRemote/common/remoteRes.manifest", "");
    assert.strictEqual(manifestRes, "{}");

    function MockRemoteResMgr() {
        this.remoteResMap = new Map();
        this.remoteCheckMap = new Map();
        this.localResMap = new Map();
        this.resMap = {};
    }
    MockRemoteResMgr.prototype.loadResManifest = function () { throw new Error("should be patched"); };
    MockRemoteResMgr.prototype.loadRemoteRes = function () { throw new Error("should be patched"); };

    function MockUIMgr() {
        this._uuidList = ["u1"];
        this._multiidList = [0];
        this._showingViewList = [];
        this._isLocked = true;
        this._isLockedTime = false;
        this._views = {
            u1: {
                uiGuideName: "VillageMainView",
                cacheClassName: "VillageMainView",
                isHiding: true,
                openData: { type: 1, showType: 1 },
                viewContainer: { visible: false },
                showSelf() { throw new Error("simulated under-view showSelf crash"); }
            }
        };
    }
    MockUIMgr.prototype.getViewWith = function (u) { return this._views[u]; };
    MockUIMgr.prototype.removeMode = function () {};
    MockUIMgr.prototype.removeFromLayer = function () {};
    MockUIMgr.prototype.showUnderView = function () {};

    function MockBuildingBaseView() { this.buildingId = 15101; this.closed = false; }
    MockBuildingBaseView.prototype.saveCommonCustomerDataList = function () { throw new Error("simulated save crash"); };
    MockBuildingBaseView.prototype.doEnterStatus = function () { throw new Error("simulated enterStatus crash"); };
    MockBuildingBaseView.prototype.leaveBuilding = function () { this.doEnterStatus(this.buildingId, 0); this.closeSelf(); };
    MockBuildingBaseView.prototype.closeSelf = function () { this.closed = true; };

    global.fgui = { GRoot: { inst: { touchable: false } } };
    const MockGuideBookUtil = {
        canGetGuideBookReward() { throw new TypeError("Cannot read property 'state' of undefined"); }
    };
    const mockModules = {
        RemoteResMgr: { RemoteResMgr: MockRemoteResMgr },
        PackagesConfig: { PackagesConfig: { REMOTE_PATH: "assetsRemote/" } },
        I18nUtil: { I18nUtil: { isResValid: () => false } },
        UIMgr: { UIMgr: MockUIMgr },
        CoreTypeDefine: { ViewType: { Guide: 10, Loading: 11, Toast: 12, Top: 13, Edit: 14 }, ViewShowType: { Screen: 1 } },
        BuildingBaseView: { BuildingBaseView: MockBuildingBaseView },
        GuideBookUtil: { GuideBookUtil: MockGuideBookUtil }
    };
    global.__require = (name) => mockModules[name];

    srv.installRuntimePatches();
    assert.strictEqual(MockGuideBookUtil.canGetGuideBookReward(2300099, 10001), false, "GuideBookUtil.canGetGuideBookReward must never throw on missing task");

    // Verify RemoteResMgr patch
    const rrm = new MockRemoteResMgr();
    let manifestOk = false;
    rrm.loadResManifest(["common"], (ok) => { manifestOk = ok; });
    assert.strictEqual(manifestOk, true);
    assert.ok(rrm.remoteResMap.has("common"));
    let remoteOk = null;
    rrm.loadRemoteRes("assetsRemote/common/sound/bgm_common", ".mp3", (ok) => { remoteOk = ok; });
    assert.strictEqual(remoteOk, false);
    assert.strictEqual(await rrm.checkRemoteFileExist("x"), false);

    // Verify UIMgr freeze-proof patch
    const uiMgr = new MockUIMgr();
    let removedFromParent = false;
    uiMgr.removeFromLayer({
        uiGuideName: "BuildingBreakfastMainView",
        viewContainer: { removeFromParent() { removedFromParent = true; } }
    });
    assert.strictEqual(removedFromParent, true, "View must be removed from parent even when under-view throws!");
    assert.strictEqual(uiMgr._views.u1.viewContainer.visible, true, "Under-view must be made visible!");
    assert.strictEqual(global.fgui.GRoot.inst.touchable, true, "GRoot touchable must be restored!");

    // Verify BuildingBaseView safe leave patch
    const bbv = new MockBuildingBaseView();
    bbv.saveCommonCustomerDataList(); // must not throw
    bbv.leaveBuilding();
    assert.strictEqual(bbv.closed, true, "leaveBuilding must always closeSelf even if doEnterStatus throws!");
    console.log("   Fix v3 Runtime Patches PASS!");

    console.log("\nALL E2E TESTS PASSED 100%!");
}

runTests().catch((err) => {
    console.error("E2E TEST FAILED:", err);
    process.exit(1);
});
