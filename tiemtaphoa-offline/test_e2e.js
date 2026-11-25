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
    assert.strictEqual(servers.length, 2, "Expected S1 (Max Tester Lv60) + S2 (Newbie)");
    assert.strictEqual(servers[0].serverId, 1);
    assert.strictEqual(servers[1].serverId, 2);
    assert.strictEqual(slRes.recommendServer.serverId, 1);

    const rnRes = await post(servers[0].url + "/getRandomName", { sex: 2 });
    assert.strictEqual(rnRes.result, 0);
    assert.ok(rnRes.name.length > 0);

    // Test Server 1 (Max Tester Lv60 VIP15 Full — immediate login, hasRole=true!)
    const loginS1 = await post(servers[0].url + "/login", { openId: "tester_max", serverId: 1 });
    assert.strictEqual(loginS1.result, 0);
    assert.strictEqual(loginS1.hasRole, true, "S1 Max Tester must start ready to enter lobby!");
    const stS1 = srv.getState("tester_max", 1);
    assert.strictEqual(stS1.titleId, 60, "S1 must be Level 60");
    assert.ok(stS1.vipExp >= 99999999, "S1 must be VIP 15");
    assert.ok(stS1.bag[101011] >= 999999999, "S1 must have infinite Thẻ Giảm Giá (101011)");
    assert.strictEqual(stS1.headId, 106100, "Valid LeadDecorateDB Avatar ID");
    assert.strictEqual(stS1.costumeId, 106000, "Valid LeadDecorateDB Figure ID");
    console.log("   S1 Max Tester PASS! Lv=" + stS1.titleId + ", VIPExp=" + stS1.vipExp + ", Heroes=" + Object.keys(stS1.heroes).length + ", Beauties=" + Object.keys(stS1.beauties).length + ", Cars=" + Object.keys(stS1.cars).length);

    // Test Server 2 (Tân Thủ — starts with character creation!)
    const login1 = await post(servers[1].url + "/login", { openId: "test_user", serverId: 2 });
    assert.strictEqual(login1.result, 0);
    assert.strictEqual(login1.hasRole, false);
    const uid = login1.userId;

    const createRes = await post(servers[1].url + "/createRole", { nickName: "Tiệm Tạp Hóa 9X", sex: 2, player: 1, headId: 106100, costumeId: 106000 });
    assert.strictEqual(createRes.result, 0);
    assert.strictEqual(createRes.nickName, "Tiệm Tạp Hóa 9X");

    const login2 = await post(servers[1].url + "/login", { openId: "test_user", serverId: 2 });
    assert.strictEqual(login2.result, 0);
    assert.strictEqual(login2.hasRole, true);
    assert.strictEqual(login2.address, "127.0.0.1");
    console.log("   S2 Newbie HTTP PASS! userId=" + uid + " nickName=" + login2.nickName);

    console.log("2. Testing WebSocket + Protobuf Full Login Sync (All Fix v4 Login Packets)...");
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
        const inst = new ReqClass(srv.buildDefaultMessageObj(ReqClass, obj || {}));
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
    for (const reqId of [101, 152, 104, 105, 106, 111, 5851, 401, 501, 510, 4301, 4307, 4201, 4203, 601, 801, 7024, 7026, 7100, 5901, 5201, 203, 2005, 4902, 4920, 1001053, 1201, 1209, 301, 4851, 5601, 4002, 103]) {
        assert.ok(recvIds.includes(reqId), "Missing login sync msgId: " + reqId);
    }
    // Verify Bug 1 & 7.2: valid LeadDecorateDB IDs in 104
    const p104 = received.find((x) => x.recvMsgId === 104);
    const pDeco = JSON.parse(p104.decoded.playerBaseData.decoration);
    assert.strictEqual(pDeco["1"], 106100, "Player Avatar must be valid 106100");
    assert.strictEqual(pDeco["3"], 106000, "Player Figure must be valid 106000");

    // Verify Bug 4 & 8: Hero abilities > 0 in 510
    const p510 = received.find((x) => x.recvMsgId === 510);
    assert.ok(p510 && p510.decoded.heroAbilityList.length >= 2, "Expected HeroAbilityList in 510");
    assert.ok(Number(p510.decoded.heroAbilityList[0].heroBaseAbility) > 0, "Hero base ability must be > 0");
    assert.ok(Number(p510.decoded.heroAbilityList[0].qualification) > 0, "Hero qualification must be > 0");

    // Verify Bug 10.1: Car skinId explicitly 0 (never null!) in 4201
    const p4201 = received.find((x) => x.recvMsgId === 4201);
    assert.ok(p4201 && p4201.decoded.carList.length >= 1, "Expected carList in 4201");
    assert.strictEqual(p4201.decoded.carList[0].skinId, 0, "Car skinId must be 0 (not null) so CarMainView never crashes!");

    // Verify Bug 3 & 6: Workshop has 10 steps & maxWorkshopId >= 500
    const wsSync = received.find((x) => x.recvMsgId === 5601);
    assert.strictEqual(wsSync.decoded.workshopData.maxWorkshopId, 500, "maxWorkshopId must be 500");
    assert.strictEqual(wsSync.decoded.workshopData.workshopConfig.num, 10, "Workshop stage must have 10 steps");

    // Verify Bug 10.2 & 10.5: Houses populated in 4002 & FishStore in 7100
    const p4002 = received.find((x) => x.recvMsgId === 4002);
    assert.ok(p4002.decoded.houseList.length >= 1 && p4002.decoded.houseList[0].roomList.length >= 1, "Houses & rooms must be unlocked");
    const p7100 = received.find((x) => x.recvMsgId === 7100);
    assert.ok(p7100.decoded.level >= 1 && p7100.decoded.processes.length >= 1, "FishStore must be initialized");

    console.log("   Login Sync PASS! Received " + received.length + " valid protobuf packets including 510, 801, 7024, 7100, 5901, 5201, 2005, 4902, 1001053.");

    console.log("3. Testing ALL 13 Bug Fixes & Gameplay Protocols...");
    received.length = 0;
    // Bug 1 & 7: Title Upgrade, Change Player, Decoration Change, Skin Dress
    sendC2S(20108, {});
    sendC2S(20109, {});
    sendC2S(20177, { player: 2 });
    sendC2S(20803, { decorationType: 1, decorationId: 106110 });
    sendC2S(27021, { skinId: 109001, roleId: 102210, type: 1 });
    // Bug 3 & 6: Workshop Config, Upgrade -> Boss -> Stage 2
    sendC2S(25617, { workshopConfigIds: [1, 2, 3] });
    sendC2S(25618, { workshopConfigIds: [1, 2] });
    sendC2S(25602, { isBackend: false });
    sendC2S(25606, { isBackend: false });
    sendC2S(25607, {});
    sendC2S(25608, {});
    // Bug 4 & 8: Hero Upgrade & Equip Car
    sendC2S(20503, { patronsId: 102210, times: 5 });
    sendC2S(20506, { heroId: 102240, carId: "1001" });
    // Bug 5: TvStudio, Promote, Beauty Propagate (real reward & energy deduct!)
    sendC2S(24701, {});
    sendC2S(24705, { studioIndex: 1 });
    sendC2S(24706, { studioIndex: 1 });
    sendC2S(26651, {});
    sendC2S(26652, { count: 1 });
    sendC2S(26654, { departmentId: 1 });
    sendC2S(24308, { type: 1 });
    // Bug 9: Lottery & NewbieTarget
    sendC2S(22004, { type: 1 });
    sendC2S(2001051, {});
    sendC2S(2001052, {});
    // Bug 10: House, DanceHall, VideoHall, FishStore (Process + FastStockUp), GuideBook, Rank, Sign
    sendC2S(24001, { houseId: 1001, roomId: 10011 });
    sendC2S(26501, {});
    sendC2S(26502, {});
    sendC2S(27291, {});
    sendC2S(27293, {});
    sendC2S(27109, { processId: 1001 }); // FishStore Chế biến
    sendC2S(27112, {});               // FishStore Nhập hàng
    sendC2S(21205, { taskId: 2300001 }); // GuideBook claim
    sendC2S(21206, { index: 1 });
    sendC2S(24502, { rankType: 1, type: 1 });
    sendC2S(24852, {});
    // Bug 11: Shop exact reward, Happy52, BizWar, Train
    sendC2S(24101, { shopType: 1 });
    sendC2S(24102, { shopGoodsId: 1001, count: 2 });
    sendC2S(24021, {});
    sendC2S(24022, {});
    sendC2S(24026, { targetId: 900001 });
    sendC2S(24901, {});
    sendC2S(24903, { battleType: 1, heroIdList: [102210] });
    sendC2S(24905, {});
    sendC2S(22300, {});
    sendC2S(22301, { heroIds: [102210], seatIds: [1] });
    sendC2S(22302, { seatId: 1, oneClickFinish: true });
    // Bug 12 & Req #2: VIP Reward persistence, Privilege Reward, Infinite Voucher Paid Pack (24104 & 20605)
    sendC2S(25902, { level: 1 });
    sendC2S(25203, { privilegedType: 1 });
    sendC2S(20605, {});
    sendC2S(24104, { shopGoodsId: 20000001, coinVoucherItemId: 101011 });

    await wait(160);

    const actionIds = new Set(received.map((x) => x.recvMsgId));
    const expectedIds = [
        108, 109, 177, 803, 7021,
        5617, 5618, 5602, 5606, 5607, 5608,
        503, 506, 510,
        4701, 4705, 4706, 6651, 6652, 6653, 6654, 4308, 4307,
        2004, 1001051, 1001052,
        4001, 6501, 6502, 7291, 7293, 7109, 7112, 7100,
        1205, 1206, 4502, 4852,
        4101, 4102, 4021, 4022, 4026, 4901, 4903, 4905, 2300, 2301, 2302,
        5902, 5901, 5203, 605, 4104, 206
    ];
    for (const id of expectedIds) {
        assert.ok(actionIds.has(id), "Missing response for recvMsgId: " + id);
    }

    // Deep assertions on Bug 5.4, Bug 3, Bug 4, Bug 10.5, Bug 11.1, Bug 12.3
    const propResp = received.find((x) => x.recvMsgId === 4308);
    assert.ok(propResp.decoded.beautyPropagateList.length === 1 && Number(propResp.decoded.beautyPropagateList[0].addMoney) > 0, "Bug 5.4: Beauty Propagate must grant real addMoney!");
    const st = srv.getState("test_user", 2);
    assert.strictEqual(st.beautyEnergy, 9, "Bug 5.4: Beauty Propagate must deduct 1 energy (10 -> 9)!");
    assert.strictEqual(st.workshop.workshopId, 2, "Bug 3: Boss battle must advance workshopId 1 -> 2!");
    assert.strictEqual(st.cars["1001"].heroId, 102240, "Bug 4: Car 1001 must now be equipped on Hero 102240!");
    assert.strictEqual(st.heroes[102210].carId, 0, "Bug 4: Old hero 102210 must be unequipped!");
    assert.strictEqual(st.danceHall.level, 2, "Bug 10.3: DanceHall upgraded 1 -> 2!");
    assert.strictEqual(st.videoHall.level, 2, "Bug 10.4: VideoHall upgraded 1 -> 2!");
    assert.ok(st.fishStore.processes[0].level >= 2, "Bug 10.5: FishStore Process upgraded!");
    assert.ok(st.vipRewardedLevels.includes(1), "Bug 12.3: VIP level 1 must be persisted in rewardedLevels!");
    assert.ok(st.bag[101011] >= 999999999, "Req #2: Thẻ Giảm Giá (101011) remains infinite after buying paid pack!");
    const shopBuyResp = received.find((x) => x.recvMsgId === 4102);
    assert.ok(!shopBuyResp.decoded.goodsDeatil.startsWith("110001="), "Bug 11.1: Shop must NOT hardcode 110001!");

    // Test HTTP Simulated Recharge Order + Fulfillment
    const ordRes = await post(servers[0].url + "/recharge_order", { userId: uid, productId: 20000002 });
    assert.strictEqual(ordRes.code, 0);
    assert.ok(ordRes.data.orderId);
    const rechRes = await post(servers[0].url + "/recharge", { userId: uid, orderId: ordRes.data.orderId });
    assert.strictEqual(rechRes.code, 0);
    console.log("   All 13 Bug Fixes + Infinite Voucher Recharge PASS!");

    console.log("4. Testing Fix v4 Runtime Patches (Anti-Freeze UIMgr, Redirects, Spine->PNG Fallback, Audio BGM/SFX, Voucher Config)...");
    assert.strictEqual(srv.mapAudioToBundled("common/sound/bgm/BgmMain"), "activity/29_1/sound/bgm/Cmn");
    assert.strictEqual(srv.mapAudioToBundled("common/sound/sfx/btn_click"), "activity/1011_1/sound/sfx/LuckydrawClick");
    assert.strictEqual(srv.resolvePortraitFallbackPath("common/spine/hero/102210/skeleton"), "common/hero/102210/1");
    assert.strictEqual(srv.resolvePortraitFallbackPath("common/spine/beauty/103201/skeleton"), "common/beauty/103201/1");
    assert.strictEqual(srv.resolvePortraitFallbackPath("common/spine/skin/109001/skeleton"), "common/skin/109001/1");

    function MockRemoteResMgr() {
        this.remoteResMap = new Map();
        this.remoteCheckMap = new Map();
        this.localResMap = new Map();
        this.resMap = {};
    }
    MockRemoteResMgr.prototype.loadResManifest = function () { throw new Error("should be patched"); };
    MockRemoteResMgr.prototype.loadRemoteRes = function () { throw new Error("should be patched"); };

    let openedViewName = "";
    function MockUIMgr() {
        this._uuidList = ["u1"];
        this._multiidList = [0];
        this._showingViewList = [];
        this._isLocked = true;
        this._isLockedTime = false;
        this._isOpening = false;
        this._views = {
            u1: {
                uiGuideName: "VillageMainView",
                cacheClassName: "VillageMainView",
                isHiding: true,
                openData: { type: 1, showType: 1 },
                viewContainer: { visible: false },
                showSelf() { throw new Error("simulated crash"); }
            }
        };
    }
    MockUIMgr.prototype.open = function (uiType) { openedViewName = uiType.getClassName(); return {}; };
    MockUIMgr.prototype.openEnded = function () { this._isOpening = false; };
    MockUIMgr.prototype.getViewWith = function (u) { return this._views[u]; };
    MockUIMgr.prototype.removeMode = function () {};
    MockUIMgr.prototype.removeFromLayer = function () {};
    MockUIMgr.prototype.showUnderView = function () {};
    MockUIMgr.inst = new MockUIMgr();

    function MockBuildingBaseView() { this.buildingId = 15101; this.closed = false; }
    MockBuildingBaseView.prototype.saveCommonCustomerDataList = function () { throw new Error("simulated"); };
    MockBuildingBaseView.prototype.doEnterStatus = function () { throw new Error("simulated"); };
    MockBuildingBaseView.prototype.leaveBuilding = function () { this.doEnterStatus(this.buildingId, 0); this.closeSelf(); };
    MockBuildingBaseView.prototype.closeSelf = function () { this.closed = true; };

    function MockAudioMgr() {}
    MockAudioMgr.prototype.load = function () { throw new Error("should be patched"); };

    function MockResetRoleMainView() {}
    MockResetRoleMainView.prototype.checkIsEffectiveTime = function () { return false; };

    const MockGameConfig = { isForceSimulateRecharge: false, isSDKWithPlatform: true };
    const MockStartPrivilege = { openMain() { throw new Error("should be patched"); } };
    const MockShopMainView = { getClassName: () => "ShopMainView" };
    const MockCashPackHelperView = { getClassName: () => "CashPackHelperView" };
    const MockPrivilegeMainView = { getClassName: () => "PrivilegeMainView" };

    global.cc.AudioClip = function () {};
    let loadedAudioPath = "";
    global.cc.resources = {
        load(path, type, cb) {
            loadedAudioPath = path;
            cb(null, { name: path });
        }
    };
    global.fgui = { GRoot: { inst: { touchable: false } } };
    const MockGuideBookUtil = { canGetGuideBookReward() { throw new TypeError("missing task"); } };
    const mockModules = {
        RemoteResMgr: { RemoteResMgr: MockRemoteResMgr },
        PackagesConfig: { PackagesConfig: { REMOTE_PATH: "assetsRemote/" } },
        I18nUtil: { I18nUtil: { isResValid: () => false } },
        UIMgr: { UIMgr: MockUIMgr },
        ShopMainView: { ShopMainView: MockShopMainView },
        PrivilegeMainView: { PrivilegeMainView: MockPrivilegeMainView },
        StartPrivilegeCmnUtil: { StartPrivilegeCmnUtil: MockStartPrivilege },
        AudioMgr: { AudioMgr: MockAudioMgr },
        GameConfig: { GameConfig: MockGameConfig },
        ResetRoleMainView: { ResetRoleMainView: MockResetRoleMainView },
        CoreTypeDefine: { ViewType: { Guide: 10, Loading: 11, Toast: 12, Top: 13, Edit: 14 }, ViewShowType: { Screen: 1 } },
        BuildingBaseView: { BuildingBaseView: MockBuildingBaseView },
        GuideBookUtil: { GuideBookUtil: MockGuideBookUtil }
    };
    global.__require = (name) => mockModules[name];

    srv.installRuntimePatches();
    assert.strictEqual(MockGameConfig.isForceSimulateRecharge, true, "GameConfig.isForceSimulateRecharge must be true!");
    assert.strictEqual(MockGameConfig.isSDKWithPlatform, false, "GameConfig.isSDKWithPlatform must be false!");
    assert.strictEqual(new MockResetRoleMainView().checkIsEffectiveTime(), true, "ResetRoleMainView must allow all starter roles!");

    // Bug 2 redirect: CashPackHelperView -> ShopMainView
    MockUIMgr.inst.open(MockCashPackHelperView);
    assert.strictEqual(openedViewName, "ShopMainView", "CashPackHelperView must redirect to ShopMainView!");

    // Bug 12.2 redirect: StartPrivilegeCmnUtil.openMain -> PrivilegeMainView
    MockStartPrivilege.openMain();
    assert.strictEqual(openedViewName, "PrivilegeMainView", "StartPrivilegeCmnUtil.openMain must redirect to PrivilegeMainView!");

    // Bug 13 audio mapping: common/sound/bgm/BgmMain -> bundled Cmn MP3
    let loadedClip = null;
    new MockAudioMgr().load("common/sound/bgm/BgmMain", (clip) => { loadedClip = clip; });
    assert.strictEqual(loadedAudioPath, "activity/29_1/sound/bgm/Cmn");
    assert.ok(loadedClip, "AudioMgr.load must return bundled AudioClip!");

    // Anti-freeze UIMgr.removeFromLayer
    let removedFromParent = false;
    MockUIMgr.inst.removeFromLayer({
        uiGuideName: "BuildingBreakfastMainView",
        viewContainer: { removeFromParent() { removedFromParent = true; } }
    });
    assert.strictEqual(removedFromParent, true);
    assert.strictEqual(global.fgui.GRoot.inst.touchable, true);
    console.log("   Fix v4 Runtime Patches PASS!");

    console.log("\nALL FIX V4 E2E TESTS PASSED 100%!");
}

runTests().catch((err) => {
    console.error("E2E TEST FAILED:", err);
    process.exit(1);
});
