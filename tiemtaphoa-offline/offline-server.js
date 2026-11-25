(function (global) {
    "use strict";

    if (global.__GCXUA_OFFLINE_SERVER_INSTALLED__) {
        return;
    }
    global.__GCXUA_OFFLINE_SERVER_INSTALLED__ = true;

    var LOG_PREFIX = "[OfflineServer]";
    function log() {
        try {
            var args = [LOG_PREFIX];
            for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
            console.log.apply(console, args);
        } catch (e) {}
    }

    function warn() {
        try {
            var args = [LOG_PREFIX + "[WARN]"];
            for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
            console.warn ? console.warn.apply(console, args) : console.log.apply(console, args);
        } catch (e) {}
    }

    // =========================================================================
    // 1. Safe Storage Helpers
    // =========================================================================
    var SAVE_KEY_PREFIX = "__gcxua_offline_save_v1__";
    var CLIENT_PARAM_KEY = "__gcxua_offline_client_param_v1__";

    function getStorage() {
        if (global.cc && global.cc.sys && global.cc.sys.localStorage) {
            return global.cc.sys.localStorage;
        }
        if (global.localStorage) {
            return global.localStorage;
        }
        if (!global.__offlineMemStorage) {
            var mem = {};
            global.__offlineMemStorage = {
                getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
                setItem: function (k, v) { mem[k] = String(v); },
                removeItem: function (k) { delete mem[k]; }
            };
        }
        return global.__offlineMemStorage;
    }

    function loadJSON(key, fallback) {
        try {
            var raw = getStorage().getItem(key);
            if (raw && raw.length > 0) return JSON.parse(raw);
        } catch (e) {}
        return fallback;
    }

    function saveJSON(key, val) {
        try {
            getStorage().setItem(key, JSON.stringify(val));
        } catch (e) {
            warn("saveJSON failed:", key, e && e.message);
        }
    }

    // Pre-seed PLAYER_INFO so LoginMainView debug/offline input is pre-filled
    try {
        var existingPlayerInfo = loadJSON("PLAYER_INFO", null);
        if (!existingPlayerInfo || !existingPlayerInfo.uid) {
            saveJSON("PLAYER_INFO", { uid: "tiemtaphoa01", serverId: 1 });
        }
    } catch (e) {}

    // =========================================================================
    // 2. Native JNI Bridge Guard (prevent SDK / Ad / Bugly NPE crashes)
    // =========================================================================
    function installJsbGuard() {
        try {
            if (!global.jsb || !global.jsb.reflection || !global.jsb.reflection.callStaticMethod) {
                return;
            }
            if (global.jsb.reflection.__offlineGuarded) return;
            var origCall = global.jsb.reflection.callStaticMethod.bind(global.jsb.reflection);
            global.jsb.reflection.callStaticMethod = function (cls, method, sig) {
                var rest = [];
                for (var i = 3; i < arguments.length; i++) rest.push(arguments[i]);

                if (cls === "org/cocos2dx/javascript/plugin/YqSdkMgr") {
                    if (method === "checkIsSupportSDK") return false;
                    if (method === "sdkInitFinished") return "true";
                    if (method === "getAdChannelData" || method === "getAdPlatform" || method === "supportMethod") return "";
                    if (method === "showAd") {
                        // Immediately reward ad playback in offline mode
                        setTimeout(function () {
                            try {
                                if (global.U8SDKCallback && global.U8SDKCallback.onAdVideoResult) {
                                    global.U8SDKCallback.onAdVideoResult("1");
                                }
                            } catch (e) {}
                        }, 50);
                        return;
                    }
                    log("Blocked YqSdkMgr." + method);
                    if (sig && sig.indexOf(")Z") >= 0) return false;
                    if (sig && sig.indexOf(")I") >= 0) return 0;
                    if (sig && sig.indexOf(")Ljava/lang/String;") >= 0) return "";
                    return;
                }

                if (
                    cls === "com/xmyanqu/dq/SDK37Tools" ||
                    cls === "com/xmyanqu/mylibrary/AdVideoMgr" ||
                    cls === "org/cocos2dx/javascript/bugly/BuglyExt"
                ) {
                    if (sig && sig.indexOf(")Z") >= 0) return false;
                    if (sig && sig.indexOf(")I") >= 0) return 0;
                    if (sig && sig.indexOf(")Ljava/lang/String;") >= 0) return "";
                    return;
                }

                try {
                    return origCall.apply(null, [cls, method, sig].concat(rest));
                } catch (err) {
                    warn("JNI call failed:", cls, method, err && err.message);
                    if (sig && sig.indexOf(")Z") >= 0) return false;
                    if (sig && sig.indexOf(")I") >= 0) return 0;
                    if (sig && sig.indexOf(")Ljava/lang/String;") >= 0) return "";
                    return;
                }
            };
            global.jsb.reflection.__offlineGuarded = true;
            log("Installed JSB reflection guard");
        } catch (e) {
            warn("installJsbGuard error:", e && e.message);
        }
    }
    installJsbGuard();

    // =========================================================================
    // 3. Game Module & DB Accessors (resolved lazily after script bundle loads)
    // =========================================================================
    function getModule(name) {
        try {
            if (typeof global.__require === "function") {
                return global.__require(name);
            }
        } catch (e) {}
        return null;
    }

    function getProtobufMgr() {
        if (global.__OFFLINE_PROTOBUF_MGR__) return global.__OFFLINE_PROTOBUF_MGR__;
        var m = getModule("ProtobufMgr");
        return m && m.ProtobufMgr ? m.ProtobufMgr.inst : null;
    }

    function getProtocol() {
        if (global.__OFFLINE_PROTOCOL__) return global.__OFFLINE_PROTOCOL__;
        var m = getModule("Protocol");
        return m && m.Protocol ? m.Protocol : null;
    }

    function getDBUtil() {
        var m = getModule("DBUtil");
        return m && m.DBUtil ? m.DBUtil : null;
    }

    function getDBMgr() {
        var m = getModule("DBMgr");
        return m && m.DBMgr ? m.DBMgr.inst : null;
    }

    function toRecvProtocol(cmdId) {
        if (cmdId < 1000000) return cmdId % 10000;
        if (cmdId < 2000000) return cmdId;
        return cmdId - 1000000;
    }

    // =========================================================================
    // 4. Random Vietnamese Names & Reward Parsing Helpers
    // =========================================================================
    var RANDOM_NAMES_MALE = [
        "Anh Hai Tạp Hóa", "Chú Ba Chợ Cũ", "Ông Chủ 9X", "Tư Bánh Mì",
        "Minh Khôi", "Quốc Bảo", "Hoàng Nam", "Thành Đạt", "Phúc Thịnh", "Gia Huy"
    ];
    var RANDOM_NAMES_FEMALE = [
        "Cô Ba Chợ Xưa", "Chị Tư Tạp Hóa", "Bé Na Quán Sáng", "Ngọc Trinh 9X",
        "Minh Thư", "Bảo Ngọc", "Thanh Trúc", "Khánh Linh", "Thảo Vy", "Lan Anh"
    ];

    function pickRandomName(sex) {
        var list = sex === 2 ? RANDOM_NAMES_FEMALE : RANDOM_NAMES_MALE;
        return list[Math.floor(Math.random() * list.length)];
    }

    function parseRewardString(str) {
        var out = [];
        if (!str || str === "0") return out;
        var parts = String(str).split(/[;|,]/);
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            if (!p) continue;
            var kv = p.split(/[=:]/);
            if (kv.length >= 2) {
                var id = parseInt(kv[0], 10);
                var count = parseInt(kv[1], 10);
                if (!isNaN(id) && !isNaN(count) && count > 0) {
                    out.push({ id: id, count: count });
                }
            }
        }
        return out;
    }

    function addBigNumStr(a, b) {
        var na = Number(a || 0);
        var nb = Number(b || 0);
        if (!isFinite(na)) na = 0;
        if (!isFinite(nb)) nb = 0;
        return String(Math.max(0, Math.floor(na + nb)));
    }

    function subBigNumStr(a, b) {
        var na = Number(a || 0);
        var nb = Number(b || 0);
        if (!isFinite(na)) na = 0;
        if (!isFinite(nb)) nb = 0;
        return String(Math.max(0, Math.floor(na - nb)));
    }

    // =========================================================================
    // 5. Player State Model & Persistence
    // =========================================================================
    var currentOpenId = "tiemtaphoa01";
    var stateCache = {};

    function hashUserId(openId) {
        var h = 100001;
        var s = String(openId || "tiemtaphoa01");
        for (var i = 0; i < s.length; i++) {
            h = ((h * 31) + s.charCodeAt(i)) % 900000;
        }
        return 100000 + Math.abs(h);
    }

    function getDefaultSystems() {
        var list = [];
        for (var i = 1; i <= 150; i++) list.push(i);
        return list;
    }

    function createInitialState(openId) {
        var now = Date.now();
        var uid = hashUserId(openId);
        return {
            openId: openId,
            userId: uid,
            hasRole: false,
            nickName: "Chủ Tiệm Xưa",
            sex: 1,
            headId: 10001,
            costumeId: 100100,
            player: 1,
            playerSign: "Chào mừng đến Góc Chợ Xưa Offline!",
            titleId: 1,
            vipExp: 5000,
            ingots: 99999,
            silver: "500000",
            patronsExp: "100000",
            prestige: "50",
            rechargeToken: 1000,
            earnSpeed: "100",
            registerTime: now,
            lastLoginTime: now,
            lastTickTime: now,
            getTitleRewardTime: 0,
            loginTotalDays: 1,
            guideId: 0,
            guideParam: "",
            clientStates: {},
            vnSaveParam: "{}",
            openSystems: getDefaultSystems(),
            buildings: {
                15101: {
                    buildingId: 15101,
                    level: 1,
                    expendlevel: 0,
                    buildingStatus: 2, // opened
                    cleanItemList: [],
                    heroIdList: [102210],
                    businessList: [
                        { businessId: 10101, status: 0 }
                    ],
                    buildingName: "",
                    questionNum: 3,
                    autoSwitch: 1,
                    openTime: now
                }
            },
            buildingServeCounts: { 15101: 0 },
            heroes: {
                102210: {
                    patronsId: 102210,
                    level: 10,
                    stageLv: 1,
                    breakLv: 0,
                    skillList: [
                        { skillId: 10021, skillLv: 1, type: 1 },
                        { skillId: 10031, skillLv: 1, type: 1 },
                        { skillId: 10041, skillLv: 1, type: 1 }
                    ],
                    addAbility: "500",
                    tradeWarAddEarnSpeed: "0",
                    skinId: 0,
                    carId: 104001,
                    sumAbility: "2500",
                    promotionId: 0,
                    awakenLevel: 0,
                    expertLev: 0,
                    addTime: Math.floor(now / 1000)
                },
                102240: {
                    patronsId: 102240,
                    level: 1,
                    stageLv: 1,
                    breakLv: 0,
                    skillList: [{ skillId: 10021, skillLv: 1, type: 1 }],
                    addAbility: "200",
                    tradeWarAddEarnSpeed: "0",
                    skinId: 0,
                    carId: 0,
                    sumAbility: "1200",
                    promotionId: 0,
                    awakenLevel: 0,
                    expertLev: 0,
                    addTime: Math.floor(now / 1000)
                }
            },
            beauties: {
                103201: {
                    beautyId: 103201,
                    affinity: 100,
                    level: 1,
                    identitySkillLv: 1,
                    skillList: [
                        { skillPos: 1, skillValue: 50, modifyNum: 0 }
                    ],
                    isShow: true,
                    createTime: now,
                    influence: 100,
                    fetterVal: 100,
                    artVal: 100,
                    subSkillList: [],
                    quality: 2,
                    readVoice: [],
                    voice: 0,
                    playNum: 0,
                    skinId: 0
                }
            },
            beautyEnergy: 10,
            beautyEnergyTime: now,
            cars: {
                "car_104001": {
                    carId: "car_104001",
                    templateId: 104001,
                    level: 1,
                    breakLv: 0,
                    heroId: 102210,
                    isShow: true,
                    rank: 1,
                    skillList: [
                        { skillPos: 1, skillType: 1, skillAttr: 1, value: 10, skillModifyTimes: 0, randomSkillAttr: 0, randomValue: 0 }
                    ],
                    equipNum: 1,
                    status: 1
                }
            },
            bag: {
                110001: 500, // Expansion / Store upgrade cards
                110002: 500,
                110008: 200, // Hero break materials
                110009: 200,
                110010: 200,
                110040: 100,
                119000: 20,
                119001: 20
            },
            mainTaskId: 200001,
            tasks: {
                200001: { taskId: 200001, value: "1", state: 0, finishTime: 0, taskStartTime: 0, taskEndTime: 0 },
                100001: { taskId: 100001, value: "1", state: 0, finishTime: 0, taskStartTime: 0, taskEndTime: 0 },
                2201101: { taskId: 2201101, value: "1", state: 1, finishTime: Math.floor(now / 1000), taskStartTime: 0, taskEndTime: 0 }
            },
            completeTaskIds: [2201101],
            buildingHandleDetails: {},
            heroSkillUpgradeCount: 0,
            workshop: {
                workshopId: 1,
                sectionProgress: 1,
                buyBuffTimes: 0,
                itemBuyBuffTimes: 0,
                events: [],
                isBoss: 0,
                autoBuyBuffTimes: 0,
                autoItemBuyBuffTimes: 0,
                sceneEvent: [],
                urgeTime: 0,
                urgeCount: 0,
                waste: 0,
                workerEarnSpeedAdd: 0,
                workerEarnFixedAdd: 0,
                totalWorkerEarnSpeedAdd: 0,
                totalWorkerEarnFixedAdd: 0,
                totalEarnAddValue: 0,
                maxWorkshopId: 1
            },
            taskActive: 10,
            taskActiveRewards: [],
            sevenDayActive: 10,
            sevenDayRewards: [],
            road: {
                passId: 1,
                passProgress: 0,
                buyBuffTimes: 0,
                itemBuyBuffTimes: 0,
                events: [],
                maxPassId: 1
            },
            sign: {
                currentSignDays: 0,
                lastSignDays: 0,
                totalSignDays: 0,
                gainedAccumulateIndex: [],
                cycleCount: 1,
                lastSignDate: ""
            },
            mails: [
                {
                    mailUid: "offline_welcome_001",
                    mailType: 1,
                    title: "Chào mừng đến Góc Chợ Xưa Offline!",
                    content: "Server Offline đã khởi chạy thành công! Nhận quà tân thủ để xây dựng khu chợ 9X của bạn. Mẹo: nhập mã đổi thưởng OFFLINE, RICH, hoặc ALLHERO trong Cài đặt -> Đổi quà để nhận thêm tài nguyên!",
                    annexes: "101000=100000;101001=50000;101003=50000;110001=100",
                    sendTime: Math.floor(now / 1000),
                    sendUserId: 0,
                    sendNickName: "Hệ thống Offline",
                    receiveUserId: uid,
                    isRead: false,
                    readTime: 0,
                    isGetReward: false,
                    functionOp: 0,
                    params: []
                }
            ],
            shopBought: {},
            usedCodes: {}
        };
    }

    function ensureBusinessInBuilding(b, businessId) {
        if (!b) return false;
        b.businessList = b.businessList || [];
        for (var i = 0; i < b.businessList.length; i++) {
            if (Number(b.businessList[i].businessId) === Number(businessId)) return false;
        }
        b.businessList.push({ businessId: Number(businessId), status: 0 });
        return true;
    }

    function syncAllBusinessTasks(st) {
        var changedTasks = [];
        var newlyCompletedIds = [];
        var changedBuildings = [];
        if (!st || !st.buildings) return { changedTasks: changedTasks, newlyCompletedIds: newlyCompletedIds, changedBuildings: changedBuildings };

        st.tasks = st.tasks || {};
        st.completeTaskIds = st.completeTaskIds || [];

        // Always guarantee Breakfast Stall starter dish (10101 -> unlockCondition 2201101)
        if (st.buildings[15101]) {
            if (st.completeTaskIds.indexOf(2201101) < 0) {
                st.completeTaskIds.push(2201101);
                newlyCompletedIds.push(2201101);
            }
            if (ensureBusinessInBuilding(st.buildings[15101], 10101)) {
                changedBuildings.push(st.buildings[15101]);
            }
            if (!st.tasks[2201101]) {
                st.tasks[2201101] = {
                    taskId: 2201101,
                    value: String(st.buildings[15101].level || 1),
                    state: 1,
                    finishTime: Math.floor(Date.now() / 1000),
                    taskStartTime: 0,
                    taskEndTime: 0
                };
                changedTasks.push(st.tasks[2201101]);
            }
        }

        var dbUtil = getDBUtil();
        if (!dbUtil || !dbUtil.getStoreSetingListByBuildingId || !dbUtil.getTask) {
            return { changedTasks: changedTasks, newlyCompletedIds: newlyCompletedIds, changedBuildings: changedBuildings };
        }

        var nowSec = Math.floor(Date.now() / 1000);
        for (var bidKey in st.buildings) {
            if (!st.buildings.hasOwnProperty(bidKey)) continue;
            var bid = Number(bidKey);
            var b = st.buildings[bidKey];
            if (!b) continue;
            var bLv = Number(b.level || 1);
            var sList = [];
            try { sList = dbUtil.getStoreSetingListByBuildingId(bid) || []; } catch (e) {}
            var bModified = false;

            for (var i = 0; i < sList.length; i++) {
                var sCfg = sList[i];
                if (!sCfg || Number(sCfg.type) !== 1 || !sCfg.unlockCondition) continue;
                var uTid = Number(sCfg.unlockCondition);
                var tCfg = null;
                try { tCfg = dbUtil.getTask(uTid); } catch (e) {}
                var reqLv = 1;
                if (tCfg && tCfg.completeParams) {
                    var parts = String(tCfg.completeParams).split("|");
                    reqLv = parseInt(parts[3] || "1", 10) || 1;
                }

                // Auto-unlock starter dishes (reqLv <= 1) for any opened building
                if (reqLv <= 1) {
                    if (st.completeTaskIds.indexOf(uTid) < 0) {
                        st.completeTaskIds.push(uTid);
                        newlyCompletedIds.push(uTid);
                    }
                    if (ensureBusinessInBuilding(b, sCfg.id)) {
                        bModified = true;
                    }
                }

                var isDone = st.completeTaskIds.indexOf(uTid) >= 0;
                if (isDone && ensureBusinessInBuilding(b, sCfg.id)) {
                    bModified = true;
                }

                var existing = st.tasks[uTid];
                var targetValStr = String(bLv);
                if (!existing) {
                    st.tasks[uTid] = {
                        taskId: uTid,
                        value: targetValStr,
                        state: isDone ? 1 : 0,
                        finishTime: isDone ? nowSec : 0,
                        taskStartTime: 0,
                        taskEndTime: 0
                    };
                    changedTasks.push(st.tasks[uTid]);
                } else {
                    var dirty = false;
                    if (Number(existing.value || 0) < bLv) {
                        existing.value = targetValStr;
                        dirty = true;
                    }
                    if (isDone && existing.state !== 1) {
                        existing.state = 1;
                        existing.finishTime = existing.finishTime || nowSec;
                        dirty = true;
                    }
                    if (dirty) changedTasks.push(existing);
                }
            }
            if (bModified && changedBuildings.indexOf(b) < 0) {
                changedBuildings.push(b);
            }
        }
        return { changedTasks: changedTasks, newlyCompletedIds: newlyCompletedIds, changedBuildings: changedBuildings };
    }

    function migrateState(st) {
        if (!st) return st;
        if (!st.completeTaskIds) st.completeTaskIds = [];
        if (!st.buildingHandleDetails) st.buildingHandleDetails = {};
        if (!st.buildingServeCounts) st.buildingServeCounts = { 15101: 0 };
        if (st.heroSkillUpgradeCount === undefined) st.heroSkillUpgradeCount = 0;
        if (!st.workshop) {
            st.workshop = {
                workshopId: 1,
                sectionProgress: 1,
                buyBuffTimes: 0,
                itemBuyBuffTimes: 0,
                events: [],
                isBoss: 0,
                autoBuyBuffTimes: 0,
                autoItemBuyBuffTimes: 0,
                sceneEvent: [],
                urgeTime: 0,
                urgeCount: 0,
                waste: 0,
                workerEarnSpeedAdd: 0,
                workerEarnFixedAdd: 0,
                totalWorkerEarnSpeedAdd: 0,
                totalWorkerEarnFixedAdd: 0,
                totalEarnAddValue: 0,
                maxWorkshopId: 1
            };
        }
        // Repair Breakfast Stall starter business (2201101 -> 10101) on older saves
        if (st.buildings && st.buildings[15101]) {
            if (st.completeTaskIds.indexOf(2201101) < 0) {
                st.completeTaskIds.push(2201101);
            }
            ensureBusinessInBuilding(st.buildings[15101], 10101);
        }
        return st;
    }

    function getState(openId) {
        openId = openId || currentOpenId || "tiemtaphoa01";
        currentOpenId = openId;
        if (!stateCache[openId]) {
            var saved = loadJSON(SAVE_KEY_PREFIX + openId, null);
            if (saved && saved.userId) {
                // Ensure new fields exist on older saves
                var def = createInitialState(openId);
                for (var k in def) {
                    if (saved[k] === undefined) saved[k] = def[k];
                }
                stateCache[openId] = migrateState(saved);
            } else {
                stateCache[openId] = migrateState(createInitialState(openId));
            }
        }
        return stateCache[openId];
    }

    function saveState(st) {
        if (!st) return;
        saveJSON(SAVE_KEY_PREFIX + st.openId, st);
    }

    function recalcEarnSpeed(st) {
        var dbUtil = getDBUtil();
        var totalAbility = 0;
        for (var hid in st.heroes) {
            if (!st.heroes.hasOwnProperty(hid)) continue;
            var h = st.heroes[hid];
            var base = 100 + h.level * 120 + h.stageLv * 300 + h.breakLv * 500;
            h.sumAbility = String(base + Number(h.addAbility || 0));
            totalAbility += Number(h.sumAbility);
        }
        var bEarn = 0;
        for (var bid in st.buildings) {
            if (!st.buildings.hasOwnProperty(bid)) continue;
            var b = st.buildings[bid];
            var basePerLv = 5;
            if (dbUtil && dbUtil.getMainBuilding) {
                try {
                    var cfg = dbUtil.getMainBuilding(Number(bid));
                    if (cfg && cfg.storeLevelUpEarning) basePerLv = Number(cfg.storeLevelUpEarning);
                } catch (e) {}
            }
            var mult = 1 + (b.expendlevel || 0) * 0.5 + (b.businessList ? b.businessList.length * 0.15 : 0) + (b.heroIdList ? b.heroIdList.length * 0.35 : 0);
            bEarn += Math.ceil((basePerLv * b.level + totalAbility / 1000) * mult);
        }
        if (bEarn < 50) bEarn = 50;
        st.earnSpeed = String(bEarn);
        return bEarn;
    }

    function tickPassiveIncome(st) {
        var now = Date.now();
        var elapsedSec = Math.floor((now - (st.lastTickTime || now)) / 1000);
        if (elapsedSec > 0) {
            if (elapsedSec > 86400) elapsedSec = 86400;
            var speed = recalcEarnSpeed(st);
            var gained = speed * elapsedSec;
            if (gained > 0) {
                st.silver = addBigNumStr(st.silver, gained);
            }
            st.lastTickTime = now;
        }
        return st.silver;
    }

    function grantItem(st, itemId, count) {
        itemId = Number(itemId);
        count = Number(count);
        if (!itemId || !count || count <= 0) return;
        if (itemId === 101000) {
            st.silver = addBigNumStr(st.silver, count);
        } else if (itemId === 101001) {
            st.ingots = Number(st.ingots || 0) + count;
        } else if (itemId === 101002) {
            st.prestige = addBigNumStr(st.prestige, count);
        } else if (itemId === 101003) {
            st.patronsExp = addBigNumStr(st.patronsExp, count);
        } else {
            st.bag[itemId] = Number(st.bag[itemId] || 0) + count;
        }
    }

    function grantRewardString(st, rewardStr) {
        var items = parseRewardString(rewardStr);
        for (var i = 0; i < items.length; i++) {
            grantItem(st, items[i].id, items[i].count);
        }
        return items;
    }

    function evaluateTaskProgress(st, taskId) {
        var dbUtil = getDBUtil();
        if (!dbUtil || !dbUtil.getTask) return null;
        var cfg = null;
        try { cfg = dbUtil.getTask(taskId); } catch (e) {}
        if (!cfg) return null;
        var params = String(cfg.completeParams || "0|0|0|1").split("|");
        var p2 = parseInt(params[2] || "0", 10);
        var target = parseInt(params[3] || "1", 10);
        var val = 0;
        switch (cfg.completeType) {
            case 1: // login
                val = Math.max(1, st.loginTotalDays || 1);
                break;
            case 3: // building level
                val = st.buildings[p2] ? Number(st.buildings[p2].level || 1) : 0;
                break;
            case 18: // hero skill upgrade count
                val = Number(st.heroSkillUpgradeCount || 0);
                break;
            case 104: // unlock building
                val = st.buildings[p2] ? 1 : 0;
                break;
            case 105: { // total dispatched heroes across buildings
                var dispCnt = 0;
                for (var dbKey in st.buildings) {
                    if (!st.buildings.hasOwnProperty(dbKey)) continue;
                    var hl = st.buildings[dbKey].heroIdList || [];
                    dispCnt += hl.length;
                }
                val = dispCnt;
                break;
            }
            case 106: { // count heroes with level >= p2
                var hCnt = 0;
                for (var hKey in st.heroes) {
                    if (!st.heroes.hasOwnProperty(hKey)) continue;
                    if (Number(st.heroes[hKey].level || 1) >= p2) hCnt++;
                }
                val = hCnt;
                break;
            }
            case 109: // identity title level
                val = st.titleId || 1;
                break;
            case 154: { // workshop section progress (cparams: 0|0|workshopId|targetProgress)
                var ws = st.workshop || { workshopId: 1, sectionProgress: 1 };
                if (Number(ws.workshopId || 1) > p2) {
                    val = target;
                } else if (Number(ws.workshopId || 1) === p2) {
                    val = Number(ws.sectionProgress || 1);
                } else {
                    val = 0;
                }
                break;
            }
            case 157: // serve customers in building
                val = (st.buildingServeCounts && st.buildingServeCounts[p2]) ? Number(st.buildingServeCounts[p2]) : 0;
                break;
            case 170: { // unlock business
                for (var bid in st.buildings) {
                    if (!st.buildings.hasOwnProperty(bid)) continue;
                    var bl = st.buildings[bid].businessList || [];
                    for (var j = 0; j < bl.length; j++) {
                        if (Number(bl[j].businessId) === p2) val = 1;
                    }
                }
                if (!val && dbUtil.getStoreSeting) {
                    try {
                        var sCfg = dbUtil.getStoreSeting(p2);
                        if (sCfg && sCfg.unlockCondition && st.completeTaskIds && st.completeTaskIds.indexOf(Number(sCfg.unlockCondition)) >= 0) {
                            val = 1;
                        }
                    } catch (e) {}
                }
                break;
            }
            default:
                // For any other main task type, keep existing value or auto-progress gently
                var existing = st.tasks[taskId];
                val = existing ? Number(existing.value || 0) : target;
                if (val < target) val = target;
                break;
        }
        if (!st.tasks[taskId]) {
            st.tasks[taskId] = { taskId: taskId, value: String(val), state: 0, finishTime: 0, taskStartTime: 0, taskEndTime: 0 };
        } else if (Number(st.tasks[taskId].value || 0) < val) {
            st.tasks[taskId].value = String(val);
        }
        return st.tasks[taskId];
    }

    function updateAllActiveTasks(st) {
        var changed = [];
        for (var tid in st.tasks) {
            if (!st.tasks.hasOwnProperty(tid)) continue;
            var t = st.tasks[tid];
            if (t.state === 0) {
                var prev = t.value;
                evaluateTaskProgress(st, Number(tid));
                if (t.value !== prev) changed.push(t);
            }
        }
        return changed;
    }

    // =========================================================================
    // 6. Protobuf Binary Framing & Generic Auto-Schema Builder
    // =========================================================================
    var MSG_HEADER = 29099;
    var BYTES_OF_HEADER = 18;

    function buildDefaultMessageObj(MsgClass, overrides, depth) {
        depth = depth || 0;
        var out = {};
        if (!MsgClass || !MsgClass.$type || !MsgClass.$type.children || depth > 4) {
            if (overrides) {
                for (var rawK in overrides) {
                    if (overrides.hasOwnProperty(rawK) && overrides[rawK] !== undefined) {
                        out[rawK] = overrides[rawK];
                    }
                }
            }
            return out;
        }
        var children = MsgClass.$type.children;
        for (var i = 0; i < children.length; i++) {
            var f = children[i];
            var fname = f.name;
            var hasOverride = overrides && overrides.hasOwnProperty(fname) && overrides[fname] !== undefined;
            if (hasOverride) {
                var val = overrides[fname];
                if (!f.repeated && f.resolvedType && f.resolvedType.clazz && typeof val === "object" && val !== null) {
                    out[fname] = buildDefaultMessageObj(f.resolvedType.clazz, val, depth + 1);
                } else if (f.repeated && f.resolvedType && f.resolvedType.clazz && Array.isArray(val)) {
                    var arr = [];
                    for (var j = 0; j < val.length; j++) {
                        arr.push(typeof val[j] === "object" && val[j] !== null
                            ? buildDefaultMessageObj(f.resolvedType.clazz, val[j], depth + 1)
                            : val[j]);
                    }
                    out[fname] = arr;
                } else {
                    out[fname] = val;
                }
                continue;
            }
            if (f.repeated) {
                continue;
            }
            if (f.required || fname === "ret") {
                var tname = f.type && f.type.name ? f.type.name : "";
                if (tname === "string") {
                    out[fname] = "";
                } else if (tname === "bool") {
                    out[fname] = false;
                } else if (tname === "bytes") {
                    out[fname] = new Uint8Array(0);
                } else if (tname === "message" && f.resolvedType && f.resolvedType.clazz) {
                    out[fname] = buildDefaultMessageObj(f.resolvedType.clazz, {}, depth + 1);
                } else if (tname === "enum" && f.resolvedType && f.resolvedType.children && f.resolvedType.children.length > 0) {
                    out[fname] = f.resolvedType.children[0].id;
                } else {
                    out[fname] = 0;
                }
            }
        }
        return out;
    }

    function encodePacket(recvMsgId, userId, payloadObj) {
        var pbMgr = getProtobufMgr();
        if (!pbMgr) {
            warn("ProtobufMgr unavailable for msgId", recvMsgId);
            return null;
        }
        var MsgClass = pbMgr.getMsg(recvMsgId, false, true);
        if (!MsgClass) {
            warn("No S2C MsgClass for recvMsgId", recvMsgId);
            return null;
        }
        var safeObj = buildDefaultMessageObj(MsgClass, payloadObj || {}, 0);
        var inst = new MsgClass(safeObj);
        var encoded = inst.encode();
        var bodyLen = encoded.limit - (encoded.offset || 0);
        var totalLen = BYTES_OF_HEADER + bodyLen;
        var buf = new ArrayBuffer(totalLen);
        var u8 = new Uint8Array(buf);

        // 2-byte header (big-endian): 29099
        u8[0] = (MSG_HEADER >>> 8) & 0xff;
        u8[1] = MSG_HEADER & 0xff;
        // 4-byte total length (big-endian)
        u8[2] = (totalLen >>> 24) & 0xff;
        u8[3] = (totalLen >>> 16) & 0xff;
        u8[4] = (totalLen >>> 8) & 0xff;
        u8[5] = totalLen & 0xff;
        // 4-byte recvMsgId (big-endian)
        u8[6] = (recvMsgId >>> 24) & 0xff;
        u8[7] = (recvMsgId >>> 16) & 0xff;
        u8[8] = (recvMsgId >>> 8) & 0xff;
        u8[9] = recvMsgId & 0xff;
        // 8-byte userId (big-endian signed int64)
        var longVal = global.Long ? global.Long.fromNumber(Number(userId || 0)) : { high: 0, low: Number(userId || 0) };
        u8[10] = (longVal.high >>> 24) & 0xff;
        u8[11] = (longVal.high >>> 16) & 0xff;
        u8[12] = (longVal.high >>> 8) & 0xff;
        u8[13] = longVal.high & 0xff;
        u8[14] = (longVal.low >>> 24) & 0xff;
        u8[15] = (longVal.low >>> 16) & 0xff;
        u8[16] = (longVal.low >>> 8) & 0xff;
        u8[17] = longVal.low & 0xff;

        // Protobuf payload bytes
        var view = encoded.view;
        var off = encoded.offset || 0;
        for (var i = 0; i < bodyLen; i++) {
            u8[BYTES_OF_HEADER + i] = view[off + i];
        }
        return buf;
    }

    function decodeClientPacket(arrayBuf) {
        var u8 = arrayBuf instanceof Uint8Array ? arrayBuf : new Uint8Array(arrayBuf);
        if (u8.length < BYTES_OF_HEADER) return null;
        var header = (u8[0] << 8) | u8[1];
        var totalLen = ((u8[2] << 24) >>> 0) + (u8[3] << 16) + (u8[4] << 8) + u8[5];
        var cmdId = (((u8[6] << 24) >>> 0) + (u8[7] << 16) + (u8[8] << 8) + u8[9]) | 0;
        var hi = (((u8[10] << 24) >>> 0) + (u8[11] << 16) + (u8[12] << 8) + u8[13]) | 0;
        var lo = (((u8[14] << 24) >>> 0) + (u8[15] << 16) + (u8[16] << 8) + u8[17]) | 0;
        var userId = global.Long ? new global.Long(lo, hi, false).toNumber() : lo;
        var body = u8.subarray(BYTES_OF_HEADER, Math.min(totalLen, u8.length));
        var reqObj = {};
        var pbMgr = getProtobufMgr();
        if (pbMgr) {
            var ReqClass = pbMgr.getMsg(cmdId, true, true);
            if (ReqClass) {
                try {
                    reqObj = ReqClass.decode(body);
                } catch (e) {
                    warn("Decode C2S failed for cmdId", cmdId, e && e.message);
                }
            }
        }
        return { header: header, totalLen: totalLen, cmdId: cmdId, userId: userId, req: reqObj };
    }

    // =========================================================================
    // 7. HTTP Offline API Router (XMLHttpRequest Interceptor)
    // =========================================================================
    function parsePostBody(body) {
        if (!body || typeof body !== "string") return {};
        var s = body.trim();
        if (s.indexOf("param=") === 0) {
            s = s.substring(6);
            try { s = decodeURIComponent(s); } catch (e) {}
        }
        try { return JSON.parse(s); } catch (e) {}
        var out = {};
        var pairs = body.split("&");
        for (var i = 0; i < pairs.length; i++) {
            var eq = pairs[i].indexOf("=");
            if (eq > 0) {
                var k = pairs[i].substring(0, eq);
                var v = pairs[i].substring(eq + 1);
                try { v = decodeURIComponent(v); } catch (e) {}
                if (k === "param") {
                    try { return JSON.parse(v); } catch (e) {}
                }
                out[k] = v;
            }
        }
        return out;
    }

    function handleHttpRequest(method, url, body) {
        var params = parsePostBody(body);
        var u = String(url || "");
        log("HTTP", method, u);

        if (u.indexOf("languagePackage") >= 0) {
            return {
                result: 0,
                languagePackageUrl: "http://127.0.0.1:8080/res"
            };
        }

        if (u.indexOf("packageUpdate") >= 0) {
            return {
                result: 0,
                isTtSs: false,
                updateLevel: 0,
                hotPackUpdateLevel: 0,
                updateUrl: "",
                hotPackUpdateUrl: ""
            };
        }

        if (u.indexOf("packageServerList") >= 0 || u.indexOf("newPackageServerList") >= 0 || u.indexOf("ServerListVN") >= 0) {
            var serverObj = {
                serverId: 1,
                name: encodeURIComponent("S1 - Góc Chợ Xưa Offline"),
                url: "http://127.0.0.1:8080",
                openTime: 1700000000000,
                status: 1,
                state: 1,
                allowLogin: true,
                isNew: true,
                markStr: ""
            };
            return {
                result: 0,
                isTishen: false,
                isTtSs: false,
                allowLogin: true,
                needShowProtectionTip: false,
                isNewUser: false,
                isReflowUser: false,
                openId: params.openId || currentOpenId || "tiemtaphoa01",
                serverList: JSON.stringify([serverObj]),
                userServerList: [1],
                recommendServer: serverObj,
                notice: ""
            };
        }

        if (u.indexOf("saveClientParam") >= 0) {
            if (params.save && params.param) {
                saveJSON(CLIENT_PARAM_KEY, params.param);
            }
            var savedParam = loadJSON(CLIENT_PARAM_KEY, "{}");
            return {
                result: 0,
                param: typeof savedParam === "string" ? savedParam : JSON.stringify(savedParam)
            };
        }

        if (u.indexOf("queryServerTime") >= 0) {
            return {
                result: 0,
                data: { time: Date.now() }
            };
        }

        if (u.indexOf("/getRandomName") >= 0) {
            return {
                result: 0,
                name: pickRandomName(params.sex || 1),
                gameTxtEditable: 1
            };
        }

        if (u.indexOf("/createRandomRole") >= 0 || u.indexOf("/createRole") >= 0) {
            var stCreate = getState(currentOpenId);
            stCreate.hasRole = true;
            if (params.nickName) stCreate.nickName = String(params.nickName);
            if (!stCreate.nickName) stCreate.nickName = pickRandomName(params.sex || 1);
            if (params.sex) stCreate.sex = Number(params.sex);
            if (params.headId) stCreate.headId = Number(params.headId);
            if (params.costumeId) stCreate.costumeId = Number(params.costumeId);
            if (params.player) stCreate.player = Number(params.player);
            stCreate.registerTime = Date.now();
            saveState(stCreate);
            return {
                result: 0,
                registerTime: stCreate.registerTime,
                nickName: stCreate.nickName
            };
        }

        if (u.indexOf("/login") >= 0) {
            var openId = params.openId || currentOpenId || "tiemtaphoa01";
            var st = getState(openId);
            return {
                result: 0,
                userId: st.userId,
                openId: st.openId,
                nickName: st.nickName,
                gameKey: "offline_key_" + st.userId,
                isRegister: !st.hasRole,
                hasRole: !!st.hasRole,
                address: "127.0.0.1",
                port: "8081",
                preStoreId: 0
            };
        }

        if (u.indexOf("recharge") >= 0 || u.indexOf("_order") >= 0) {
            return { result: 0, orderId: "offline_" + Date.now(), msg: "ok" };
        }

        // Default offline OK for any telemetry/analytics/CDN check
        return { result: 0, code: 0, msg: "ok" };
    }

    var NativeXHR = global.XMLHttpRequest;
    function OfflineXMLHttpRequest() {
        this._method = "GET";
        this._url = "";
        this._async = true;
        this._headers = {};
        this._aborted = false;
        this._isNative = false;
        this._native = null;

        this.readyState = 0;
        this.status = 0;
        this.statusText = "";
        this.responseText = "";
        this.response = "";
        this.responseType = "";
        this.timeout = 0;

        this.onreadystatechange = null;
        this.onload = null;
        this.onerror = null;
        this.ontimeout = null;
        this.onabort = null;
    }

    OfflineXMLHttpRequest.UNSENT = 0;
    OfflineXMLHttpRequest.OPENED = 1;
    OfflineXMLHttpRequest.HEADERS_RECEIVED = 2;
    OfflineXMLHttpRequest.LOADING = 3;
    OfflineXMLHttpRequest.DONE = 4;
    OfflineXMLHttpRequest.prototype.DONE = 4;

    OfflineXMLHttpRequest.prototype.open = function (method, url, async) {
        this._method = String(method || "GET").toUpperCase();
        this._url = String(url || "");
        this._async = async !== false;
        // Intercept all http:// and https:// requests in offline mode
        if (/^https?:\/\//i.test(this._url)) {
            this._isNative = false;
            this.readyState = 1;
        } else if (NativeXHR) {
            this._isNative = true;
            this._native = new NativeXHR();
            this._native.open(method, url, async);
        }
    };

    OfflineXMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        this._headers[k] = v;
        if (this._isNative && this._native) {
            this._native.setRequestHeader(k, v);
        }
    };

    OfflineXMLHttpRequest.prototype.getResponseHeader = function (k) {
        if (this._isNative && this._native) return this._native.getResponseHeader(k);
        if (String(k).toLowerCase() === "content-type") return "application/json;charset=UTF-8";
        return null;
    };

    OfflineXMLHttpRequest.prototype.getAllResponseHeaders = function () {
        if (this._isNative && this._native) return this._native.getAllResponseHeaders();
        return "Content-Type: application/json;charset=UTF-8\r\n";
    };

    OfflineXMLHttpRequest.prototype.abort = function () {
        this._aborted = true;
        if (this._isNative && this._native) this._native.abort();
    };

    OfflineXMLHttpRequest.prototype.send = function (body) {
        var self = this;
        if (this._isNative && this._native) {
            this._native.responseType = this.responseType;
            this._native.timeout = this.timeout;
            this._native.onreadystatechange = function () {
                self.readyState = self._native.readyState;
                self.status = self._native.status;
                self.responseText = self._native.responseText;
                self.response = self._native.response;
                if (self.onreadystatechange) self.onreadystatechange.call(self);
            };
            this._native.onload = function () { if (self.onload) self.onload.call(self); };
            this._native.onerror = function () { if (self.onerror) self.onerror.call(self); };
            this._native.ontimeout = function () { if (self.ontimeout) self.ontimeout.call(self); };
            this._native.send(body);
            return;
        }

        var deliver = function () {
            if (self._aborted) return;
            try {
                var respObj = handleHttpRequest(self._method, self._url, body);
                var text = typeof respObj === "string" ? respObj : JSON.stringify(respObj);
                self.status = 200;
                self.statusText = "OK";
                self.responseText = text;
                self.response = self.responseType === "json" ? respObj : text;
                self.readyState = 4;
                if (typeof self.onreadystatechange === "function") {
                    self.onreadystatechange.call(self);
                }
                if (typeof self.onload === "function") {
                    self.onload.call(self);
                }
            } catch (e) {
                warn("HTTP handler error:", self._url, e && e.message);
                self.status = 500;
                self.readyState = 4;
                if (typeof self.onerror === "function") self.onerror.call(self);
            }
        };

        if (this._async) {
            setTimeout(deliver, 15);
        } else {
            deliver();
        }
    };

    global.XMLHttpRequest = OfflineXMLHttpRequest;

    // =========================================================================
    // 8. WebSocket Gameplay Server & Handlers
    // =========================================================================
    function buildPlayerDataMsg(st) {
        var decoration = JSON.stringify({
            1: st.headId || 10001,
            3: st.costumeId || 100100
        });
        return {
            userId: st.userId,
            playerBaseData: {
                userAliasId: st.userId,
                nickName: st.nickName || "Chủ Tiệm Xưa",
                titleId: st.titleId || 1,
                decoration: decoration,
                unionName: "",
                unionUid: "",
                unionAliasId: 0,
                vipExp: st.vipExp || 0,
                sex: st.sex || 1,
                earnSpeed: String(st.earnSpeed || "50"),
                registerTime: st.registerTime || Date.now(),
                serverId: 1,
                country: "VN",
                province: "Hà Nội",
                city: "Hà Nội",
                lastLoginTime: st.lastLoginTime || Date.now(),
                prestige: String(st.prestige || "0"),
                sign: String(st.playerSign || ""),
                userId: st.userId,
                player: st.player || 1,
                openServerDay: Math.max(1, st.loginTotalDays || 1)
            },
            ingots: Number(st.ingots || 0),
            silver: String(st.silver || "0"),
            patronsExp: String(st.patronsExp || "0"),
            prestige: String(st.prestige || "0"),
            rechargeToken: Number(st.rechargeToken || 0)
        };
    }

    function objValues(map) {
        var arr = [];
        if (!map) return arr;
        for (var k in map) {
            if (map.hasOwnProperty(k)) arr.push(map[k]);
        }
        return arr;
    }

    function buildBagList(st) {
        var list = [];
        for (var id in st.bag) {
            if (st.bag.hasOwnProperty(id) && Number(st.bag[id]) > 0) {
                list.push({ goodsId: Number(id), num: Number(st.bag[id]), expiredTime: 0 });
            }
        }
        return list;
    }

    function OfflineWebSocket(url) {
        var self = this;
        this.url = url;
        this.readyState = 0; // CONNECTING
        this.binaryType = "arraybuffer";
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        this._closed = false;

        log("WebSocket connecting ->", url);
        setTimeout(function () {
            if (self._closed) return;
            self.readyState = 1; // OPEN
            if (typeof self.onopen === "function") {
                self.onopen({ type: "open" });
            }
        }, 20);
    }

    OfflineWebSocket.CONNECTING = 0;
    OfflineWebSocket.OPEN = 1;
    OfflineWebSocket.CLOSING = 2;
    OfflineWebSocket.CLOSED = 3;

    OfflineWebSocket.prototype._push = function (recvMsgId, userId, payloadObj) {
        if (this._closed || this.readyState !== 1) return;
        try {
            var buf = encodePacket(recvMsgId, userId, payloadObj);
            if (!buf) return;
            var self = this;
            setTimeout(function () {
                if (self._closed || self.readyState !== 1) return;
                if (typeof self.onmessage === "function") {
                    self.onmessage({ data: buf });
                }
            }, 5);
        } catch (e) {
            warn("_push failed for recvMsgId", recvMsgId, e && e.message);
        }
    };

    OfflineWebSocket.prototype._pushAttrs = function (st) {
        this._push(105, st.userId, {
            attributeList: [
                { key: 1, value: String(st.ingots || 0) },
                { key: 2, value: String(st.silver || "0") },
                { key: 3, value: String(st.patronsExp || "0") },
                { key: 7, value: String(st.prestige || "0") },
                { key: 8, value: String(st.getTitleRewardTime || 0) },
                { key: 21, value: String(st.loginTotalDays || 1) }
            ]
        });
    };

    OfflineWebSocket.prototype._pushEarnSpeed = function (st) {
        var sp = recalcEarnSpeed(st);
        this._push(106, st.userId, {
            totalSilver: String(st.silver || "0"),
            earnSpeed: String(sp),
            childEarnSpeed: "0",
            earnSpeedRank: 1,
            topBuildingEarnSpeed: String(sp),
            buildingEarnSpeed: String(sp)
        });
    };

    OfflineWebSocket.prototype._pushBag = function (st) {
        this._push(601, st.userId, { itemList: buildBagList(st) });
    };

    OfflineWebSocket.prototype._pushTaskUpdates = function (st) {
        var changed = updateAllActiveTasks(st);
        if (changed.length > 0) {
            this._push(1202, st.userId, { dataList: changed });
        }
    };

    OfflineWebSocket.prototype.close = function () {
        if (this._closed) return;
        this._closed = true;
        this.readyState = 3;
        var self = this;
        setTimeout(function () {
            if (typeof self.onclose === "function") {
                self.onclose({ code: 1000, reason: "offline close" });
            }
        }, 5);
    };

    OfflineWebSocket.prototype.send = function (arrayBuf) {
        if (this._closed || this.readyState !== 1) return;
        var pkt = decodeClientPacket(arrayBuf);
        if (!pkt) return;
        var cmdId = pkt.cmdId;
        var req = pkt.req || {};
        var st = getState(currentOpenId);
        var uid = pkt.userId || st.userId;
        var recvId = toRecvProtocol(cmdId);

        if (cmdId !== 20102) {
            log("C2S cmdId=" + cmdId + " -> recvId=" + recvId);
        }

        try {
            this._handleCommand(cmdId, recvId, uid, req, st);
        } catch (e) {
            warn("Command handler error cmdId=" + cmdId, e && e.message);
            // Still try generic fallback so client doesn't hang
            this._push(recvId, uid, { ret: 0 });
        }
    };

    OfflineWebSocket.prototype._handleCommand = function (cmdId, recvId, uid, req, st) {
        var now = Date.now();
        var self = this;

        switch (cmdId) {
            // ---------------- PING ----------------
            case 20102: { // M_ID_PING
                tickPassiveIncome(st);
                saveState(st);
                this._push(102, uid, {
                    time: now,
                    utc: 7,
                    e: "",
                    nanoTime: now * 1000
                });
                this._pushEarnSpeed(st);
                return;
            }

            // ---------------- LOGIN & FULL INITIAL SYNC ----------------
            case 10101: { // M_ID_LOGIN
                if (req.openId) {
                    st = getState(req.openId);
                    uid = st.userId;
                }
                migrateState(st);
                syncAllBusinessTasks(st);
                tickPassiveIncome(st);
                recalcEarnSpeed(st);
                st.lastLoginTime = now;
                evaluateTaskProgress(st, st.mainTaskId || 200001);
                updateAllActiveTasks(st);
                saveState(st);

                // Always allow returning to Main Lobby from Breakfast Stall (btnClose visible from Task #1)
                try {
                    var dbU = getDBUtil();
                    if (dbU && dbU.getConfigByParam) {
                        var backCfg = dbU.getConfigByParam("GUIDE_BREAKFAST_SHOW_BACK_BTN_TASK");
                        if (backCfg) backCfg.value = "200001";
                    }
                    var bMod = getModule("BuildingMgr");
                    if (bMod && bMod.BuildingMgr && bMod.BuildingMgr.inst && bMod.BuildingMgr.inst.model) {
                        bMod.BuildingMgr.inst.model.configGuideBreakfastShowBackBtnTask = 200001;
                    }
                } catch (e) {}

                // 1. LoginRespMsg (101)
                this._push(101, uid, {
                    ret: 0,
                    clientVer: "3.7.1",
                    systemTime: now,
                    timeZone: 7,
                    clientMajorVer: "3.7.1",
                    isTishen: false,
                    systemNanoTime: now * 1000
                });
                // 2. ChannelConfigDataMsg (152)
                this._push(152, uid, { settingSwitch: 0, gameTxtEditable: 1 });
                // 3. PlayerDataTempMsg (104)
                this._push(104, uid, buildPlayerDataMsg(st));
                // 4. AttributeListMsg (105)
                this._pushAttrs(st);
                // 5. EarnSpeedTempMsg (106)
                this._pushEarnSpeed(st);
                // 6. SystemOpenMsg (111 - S_SYSTEM_OPEN_LOGIN_DATA)
                this._push(111, uid, { openSystems: st.openSystems });
                // 7. GuideSync (5851)
                this._push(5851, uid, { guideId: st.guideId || 0, param: st.guideParam || "" });
                // 8. SyncClientStateMsg (160)
                var csList = [];
                for (var ck in st.clientStates) {
                    if (st.clientStates.hasOwnProperty(ck)) {
                        csList.push({ key: Number(ck), val: Number(st.clientStates[ck]) });
                    }
                }
                this._push(160, uid, { allStates: csList });
                // 9. Buildings (401 - U_BUILDING_INFO)
                this._push(401, uid, { buildingList: objValues(st.buildings) });
                // 10. Heroes / Patrons (501 - S_PATRONS_LOGIN_DATA)
                this._push(501, uid, { patronsList: objValues(st.heroes) });
                // 11. Beauties (4301 - S_BEAUTY_LOGIN_DATA) & Energy (4307)
                this._push(4301, uid, { beautyList: objValues(st.beauties) });
                this._push(4307, uid, { energy: st.beautyEnergy || 10, lastRestoreTime: st.beautyEnergyTime || now });
                // 12. Cars (4201 & 4203)
                this._push(4201, uid, { carList: objValues(st.cars) });
                this._push(4203, uid, { templateIdList: [104001], gainedTemplateId: [104001], skin: [] });
                // 13. Customers (4601)
                this._push(4601, uid, { customerList: [] });
                // 14. Bag (601)
                this._pushBag(st);
                // 15. Tasks (1201, 1203, 1204, 1209)
                this._push(1201, uid, { dataList: objValues(st.tasks) });
                this._push(1203, uid, { taskActive: st.taskActive || 0, rewardIndexList: st.taskActiveRewards || [] });
                this._push(1204, uid, { taskActive: st.sevenDayActive || 0, rewardIndexList: st.sevenDayRewards || [], sevenDayStartTime: st.registerTime });
                this._push(1209, uid, { taskId: st.completeTaskIds || [], all: true });
                // 16. Mail (301)
                this._push(301, uid, { mailList: st.mails || [] });
                // 17. Sign-in (4851)
                this._push(4851, uid, {
                    currentSignDays: st.sign.currentSignDays || 0,
                    lastSignDays: st.sign.lastSignDays || 0,
                    totalSignDays: st.sign.totalSignDays || 0,
                    gainedAccumulateIndex: st.sign.gainedAccumulateIndex || [],
                    cycleCount: st.sign.cycleCount || 1,
                    today: { items: [], lucks: [] },
                    yesterday: { items: [], lucks: [] }
                });
                // 18. Workshop (5601), Privileges (5201), House (4002), AllCommon (1000302, 1000303)
                if (st.workshop) {
                    this._push(5601, uid, { workshopData: st.workshop });
                }
                this._push(5201, uid, { privilegedList: [] });
                this._push(4002, uid, { houseList: [], houseComfortLevel: 1, houseComfortValue: 0 });
                this._push(1000302, uid, { heroList: [], beautyList: [], typeList: [] });
                this._push(1000303, uid, { configs: [] });
                // 19. Finally smInitDataEnd (103)
                setTimeout(function () {
                    self._push(103, uid, { ret: 0 });
                }, 40);
                return;
            }

            // ---------------- CONFIG & CLIENT STATE ----------------
            case 20133: { // S_CONFIG_VERSION
                this._push(133, uid, { configVersion: "3.7.1" });
                return;
            }
            case 20159: { // S_PLAYER_SAVE_CLIENT_STATE
                var list = req.clientStates || [];
                for (var ci = 0; ci < list.length; ci++) {
                    st.clientStates[list[ci].key] = list[ci].val;
                }
                saveState(st);
                this._push(159, uid, { ret: 0, clientStates: list });
                return;
            }
            case 29358: { // S_VN_SAVE_PARAM
                if (req.param !== undefined) st.vnSaveParam = String(req.param);
                saveState(st);
                this._push(9358, uid, { ret: 0 });
                return;
            }
            case 29359: { // S_VN_GET_SAVE_PARAM
                this._push(9359, uid, { ret: 0, param: st.vnSaveParam || "{}" });
                return;
            }
            case 25852: { // S_GUIDE_RECORD
                if (req.guideId !== undefined) st.guideId = Number(req.guideId);
                if (req.param !== undefined) st.guideParam = String(req.param);
                saveState(st);
                this._push(5852, uid, { ret: 0 });
                return;
            }

            // ---------------- PLAYER PROFILE & IDENTITY ----------------
            case 20108: { // S_TITLE_UPGRADE
                st.titleId = Number(st.titleId || 1) + 1;
                st.ingots = Number(st.ingots || 0) + 100;
                saveState(st);
                this._push(108, uid, { ret: 0, titleId: st.titleId });
                this._push(104, uid, buildPlayerDataMsg(st));
                this._pushAttrs(st);
                this._pushTaskUpdates(st);
                return;
            }
            case 20109: { // S_TITLE_GET_REWARD
                st.getTitleRewardTime = now;
                st.ingots = Number(st.ingots || 0) + 100 + (st.titleId || 1) * 20;
                saveState(st);
                this._push(109, uid, { ret: 0, getRewardTime: now });
                this._pushAttrs(st);
                return;
            }
            case 20112: { // S_CHANGE_NICK_NAME
                st.nickName = req.nickName || st.nickName;
                saveState(st);
                this._push(112, uid, { ret: 0, nickName: st.nickName });
                this._push(104, uid, buildPlayerDataMsg(st));
                return;
            }
            case 20116: { // S_GET_RANDOM_NAME
                this._push(116, uid, { name: pickRandomName(req.sex || 1) });
                return;
            }
            case 20157: { // S_CHANGE_SIGN
                st.playerSign = req.content || "";
                saveState(st);
                this._push(157, uid, { ret: 0 });
                this._push(104, uid, buildPlayerDataMsg(st));
                return;
            }
            case 20190: { // S_CHANGE_SEX
                st.sex = Number(req.sex || 1);
                saveState(st);
                this._push(190, uid, { ret: 0 });
                this._push(104, uid, buildPlayerDataMsg(st));
                return;
            }

            // ---------------- GIFT / EXCHANGE CODES ----------------
            case 20135: { // S_USE_EXCHANGE_KEY
                var code = String(req.key || "").trim().toUpperCase();
                var rewardStr = "101000=1000000;101001=50000;101003=200000;110001=200";
                if (code === "RICH" || code === "VIP999") {
                    rewardStr = "101000=999999999;101001=999999;101002=100000;101003=9999999;110001=5000;110008=1000;110009=1000;110010=1000";
                    st.vipExp = Number(st.vipExp || 0) + 100000;
                } else if (code === "ALLHERO") {
                    var dbMgr = getDBMgr();
                    var dbUtil = getDBUtil();
                    // Unlock a generous roster of heroes & beauties
                    var extraHeroes = [102210, 102240, 102220, 102230, 102241, 102231];
                    for (var hi = 0; hi < extraHeroes.length; hi++) {
                        var hid = extraHeroes[hi];
                        if (!st.heroes[hid]) {
                            st.heroes[hid] = {
                                patronsId: hid, level: 50, stageLv: 2, breakLv: 1,
                                skillList: [{ skillId: 10021, skillLv: 5, type: 1 }],
                                addAbility: "2000", tradeWarAddEarnSpeed: "0", skinId: 0,
                                carId: 0, sumAbility: "10000", promotionId: 0, awakenLevel: 0,
                                expertLev: 0, addTime: Math.floor(now / 1000)
                            };
                        }
                    }
                    var extraBeauties = [103201, 103202, 103203, 103204, 103205];
                    for (var bi = 0; bi < extraBeauties.length; bi++) {
                        var btid = extraBeauties[bi];
                        if (!st.beauties[btid]) {
                            st.beauties[btid] = {
                                beautyId: btid, affinity: 200, level: 10, identitySkillLv: 1,
                                skillList: [{ skillPos: 1, skillValue: 100, modifyNum: 0 }],
                                isShow: true, createTime: now, influence: 200, fetterVal: 200,
                                artVal: 200, subSkillList: [], quality: 2, readVoice: [], voice: 0,
                                playNum: 0, skinId: 0
                            };
                        }
                    }
                    this._push(502, uid, { patronsList: objValues(st.heroes) });
                    this._push(4302, uid, { beautyList: objValues(st.beauties) });
                }
                grantRewardString(st, rewardStr);
                recalcEarnSpeed(st);
                saveState(st);
                this._push(135, uid, { ret: 0, reward: rewardStr });
                this._pushAttrs(st);
                this._pushBag(st);
                this._pushEarnSpeed(st);
                return;
            }

            // ---------------- BUILDINGS / SHOPS ----------------
            case 20402: // S_BUILDING_CREATE
            case 20419: { // S_BUILDING_OPEN
                var bid = Number(req.buildingId || 15101);
                if (!st.buildings[bid]) {
                    st.buildings[bid] = {
                        buildingId: bid,
                        level: 1,
                        expendlevel: 0,
                        buildingStatus: 2,
                        cleanItemList: [],
                        heroIdList: [],
                        businessList: [],
                        buildingName: "",
                        questionNum: 3,
                        autoSwitch: 1,
                        openTime: now
                    };
                } else {
                    st.buildings[bid].buildingStatus = 2;
                }
                var bSyncOpen = syncAllBusinessTasks(st);
                recalcEarnSpeed(st);
                saveState(st);
                this._push(recvId, uid, { ret: 0 });
                if (bSyncOpen.newlyCompletedIds.length > 0) {
                    this._push(1209, uid, { taskId: bSyncOpen.newlyCompletedIds, all: false });
                }
                if (bSyncOpen.changedTasks.length > 0) {
                    this._push(1202, uid, { dataList: bSyncOpen.changedTasks });
                }
                this._push(405, uid, { buildingList: [st.buildings[bid]] });
                this._pushEarnSpeed(st);
                this._pushTaskUpdates(st);
                return;
            }
            case 20403: { // S_BUILDING_UPGRADE
                var ubid = Number(req.buildingId || 15101);
                var unum = Math.max(1, Number(req.upgradeNum || 1));
                var b = st.buildings[ubid];
                if (b) {
                    b.level = Number(b.level || 1) + unum;
                    var bSyncUp = syncAllBusinessTasks(st);
                    var cost = Math.min(Number(st.silver || 0), unum * b.level * 15);
                    st.silver = subBigNumStr(st.silver, cost);
                    recalcEarnSpeed(st);
                    saveState(st);
                    this._push(403, uid, { ret: 0 });
                    if (bSyncUp.newlyCompletedIds.length > 0) {
                        this._push(1209, uid, { taskId: bSyncUp.newlyCompletedIds, all: false });
                    }
                    if (bSyncUp.changedTasks.length > 0) {
                        this._push(1202, uid, { dataList: bSyncUp.changedTasks });
                    }
                    this._push(405, uid, { buildingList: [b] });
                    this._pushAttrs(st);
                    this._pushEarnSpeed(st);
                    this._pushTaskUpdates(st);
                } else {
                    this._push(403, uid, { ret: 0 });
                }
                return;
            }
            case 20412: { // S_BUILDING_EXPAND
                var ebid = Number(req.buildingId || 15101);
                var eb = st.buildings[ebid];
                if (eb) {
                    eb.expendlevel = Number(eb.expendlevel || 0) + 1;
                    recalcEarnSpeed(st);
                    saveState(st);
                    this._push(412, uid, { ret: 0, level: eb.expendlevel });
                    this._push(405, uid, { buildingList: [eb] });
                    this._pushEarnSpeed(st);
                    this._pushTaskUpdates(st);
                } else {
                    this._push(412, uid, { ret: 0, level: 1 });
                }
                return;
            }
            case 20406: { // S_BUILDING_DISPATCH_HERO
                var dbid = Number(req.buildingId || 15101);
                var dbB = st.buildings[dbid];
                if (dbB) {
                    dbB.heroIdList = Array.isArray(req.heroIdList) ? req.heroIdList.slice() : [];
                    recalcEarnSpeed(st);
                    saveState(st);
                    this._push(406, uid, { ret: 0 });
                    this._push(405, uid, { buildingList: [dbB] });
                    this._pushEarnSpeed(st);
                    this._pushTaskUpdates(st);
                } else {
                    this._push(406, uid, { ret: 0 });
                }
                return;
            }
            case 20414: { // S_BUILDING_RENAME
                var rbid = Number(req.buildingId || 15101);
                if (st.buildings[rbid]) {
                    st.buildings[rbid].buildingName = req.name || "";
                    saveState(st);
                    this._push(414, uid, { ret: 0 });
                    this._push(405, uid, { buildingList: [st.buildings[rbid]] });
                } else {
                    this._push(414, uid, { ret: 0 });
                }
                return;
            }
            case 20415: { // S_BUILDING_CLEAN
                var cbid = Number(req.buildingId || 15101);
                if (st.buildings[cbid]) {
                    st.buildings[cbid].cleanItemList = st.buildings[cbid].cleanItemList || [];
                    if (req.cleanItemId) st.buildings[cbid].cleanItemList.push(Number(req.cleanItemId));
                    saveState(st);
                    this._push(415, uid, { ret: 0 });
                    this._push(405, uid, { buildingList: [st.buildings[cbid]] });
                } else {
                    this._push(415, uid, { ret: 0 });
                }
                return;
            }
            case 20420: { // S_BUILDING_ENTER_STATUS
                var enBid = Number(req.buildingId || 15101);
                var inc = Math.max(50, Number(st.earnSpeed || 50) * 3);
                st.silver = addBigNumStr(st.silver, inc);
                saveState(st);
                this._push(420, uid, { ret: 0, income: inc, offlineIncome: 0, canGetGameCoin: 0, ticket: 0 });
                this._pushAttrs(st);
                return;
            }
            case 20423: { // S_BUILDING_GET_INCOME
                var gInc = Math.max(100, Number(st.earnSpeed || 50) * 5);
                st.silver = addBigNumStr(st.silver, gInc);
                saveState(st);
                this._push(423, uid, { ret: 0 });
                this._pushAttrs(st);
                return;
            }
            case 20424: { // S_BUILDING_HANDLE (serve customer / tap shop)
                var hbid = Number(req.buildingId || 15101);
                var hItemId = Number(req.itemId || 10101);
                var hInc = Math.max(50, Number(st.earnSpeed || 50) * 2);
                st.silver = addBigNumStr(st.silver, hInc);
                st.buildingServeCounts = st.buildingServeCounts || {};
                st.buildingServeCounts[hbid] = (st.buildingServeCounts[hbid] || 0) + 1;
                st.buildingHandleDetails = st.buildingHandleDetails || {};
                st.buildingHandleDetails[hbid] = st.buildingHandleDetails[hbid] || {};
                st.buildingHandleDetails[hbid][hItemId] = (st.buildingHandleDetails[hbid][hItemId] || 0) + 1;
                saveState(st);
                this._push(424, uid, { ret: 0, buildingId: hbid, income: String(hInc) });
                this._pushAttrs(st);
                this._pushTaskUpdates(st);
                return;
            }
            case 20428: { // S_BUILDING_HANDLE_DETAIL
                var hdbid = Number(req.buildingId || 15101);
                var detMap = (st.buildingHandleDetails && st.buildingHandleDetails[hdbid]) ? st.buildingHandleDetails[hdbid] : {};
                var detList = [];
                for (var ik in detMap) {
                    if (detMap.hasOwnProperty(ik)) {
                        detList.push({ itemId: Number(ik), num: Number(detMap[ik]) });
                    }
                }
                this._push(428, uid, { details: detList });
                return;
            }
            case 20434: { // S_BUILDING_AUTO_SWITCH
                var abid = Number(req.buildingId || 15101);
                if (st.buildings[abid]) {
                    st.buildings[abid].autoSwitch = st.buildings[abid].autoSwitch ? 0 : 1;
                    saveState(st);
                    this._push(434, uid, { ret: 0 });
                    this._push(405, uid, { buildingList: [st.buildings[abid]] });
                } else {
                    this._push(434, uid, { ret: 0 });
                }
                return;
            }

            // ---------------- WORKSHOP / FACTORY ----------------
            case 25611: { // S_WORKSHOP_INFO
                migrateState(st);
                this._push(5611, uid, { ret: 0, workshopData: st.workshop });
                this._push(5601, uid, { workshopData: st.workshop });
                return;
            }
            case 25602: { // S_WORKSHOP_UPGRADE
                migrateState(st);
                var ws = st.workshop;
                ws.sectionProgress = Number(ws.sectionProgress || 1) + 1;
                if (ws.sectionProgress > 100) {
                    ws.workshopId = Number(ws.workshopId || 1) + 1;
                    ws.maxWorkshopId = Math.max(Number(ws.maxWorkshopId || 1), ws.workshopId);
                    ws.sectionProgress = 1;
                }
                var wsExp = 200;
                var wsPrestige = 20;
                grantItem(st, 101000, 1000);
                grantItem(st, 101002, wsPrestige);
                grantItem(st, 101003, wsExp);
                saveState(st);
                this._push(5602, uid, {
                    ret: 0,
                    workshopData: ws,
                    reward: "101000=1000;101002=" + wsPrestige,
                    experience: wsExp,
                    prestige: wsPrestige
                });
                this._push(5601, uid, { workshopData: ws });
                this._pushAttrs(st);
                this._pushTaskUpdates(st);
                return;
            }
            case 25603: { // S_WORKSHOP_BUY_BUFF
                migrateState(st);
                st.workshop.buyBuffTimes = Number(st.workshop.buyBuffTimes || 0) + Math.max(1, Number(req.buyTimes || 1));
                saveState(st);
                this._push(5603, uid, { ret: 0, workshopData: st.workshop });
                this._push(5601, uid, { workshopData: st.workshop });
                return;
            }
            case 25604: // S_WORKSHOP_EVENT
            case 25605: // S_WORKSHOP_ONE_KEY_DEAL
            case 25606: { // S_WORKSHOP_BOSS_BATTLE
                migrateState(st);
                st.workshop.events = [];
                st.workshop.isBoss = 0;
                grantItem(st, 101000, 5000);
                grantItem(st, 101002, 50);
                saveState(st);
                this._push(recvId, uid, { ret: 0, workshopData: st.workshop, reward: "101000=5000;101002=50" });
                this._push(5601, uid, { workshopData: st.workshop });
                this._pushAttrs(st);
                this._pushTaskUpdates(st);
                return;
            }

            // ---------------- HEROES / PATRONS ----------------
            case 20503: { // S_PATRONS_UPGRADE
                var hid = Number(req.patronsId);
                var times = Math.max(1, Number(req.times || 1));
                var hero = st.heroes[hid];
                if (hero) {
                    hero.level = Number(hero.level || 1) + times;
                    recalcEarnSpeed(st);
                    saveState(st);
                    this._push(503, uid, { ret: 0, patrons: hero });
                    this._push(502, uid, { patronsList: [hero] });
                    this._pushEarnSpeed(st);
                    this._pushTaskUpdates(st);
                } else {
                    this._push(503, uid, { ret: 0 });
                }
                return;
            }
            case 20507: { // S_PATRONS_BREAK
                var bhid = Number(req.patronsId);
                var bhero = st.heroes[bhid];
                if (bhero) {
                    bhero.breakLv = Number(bhero.breakLv || 0) + 1;
                    recalcEarnSpeed(st);
                    saveState(st);
                    this._push(507, uid, { ret: 0, patrons: bhero });
                    this._push(502, uid, { patronsList: [bhero] });
                    this._pushEarnSpeed(st);
                } else {
                    this._push(507, uid, { ret: 0 });
                }
                return;
            }
            case 20504: { // S_PATRONS_STAGE
                var shid = Number(req.patronsId);
                var shero = st.heroes[shid];
                if (shero) {
                    shero.stageLv = Number(shero.stageLv || 1) + 1;
                    recalcEarnSpeed(st);
                    saveState(st);
                    this._push(504, uid, { ret: 0, patrons: shero });
                    this._push(502, uid, { patronsList: [shero] });
                    this._pushEarnSpeed(st);
                } else {
                    this._push(504, uid, { ret: 0 });
                }
                return;
            }
            case 20505: { // S_PATRONS_SKILL_UPGRADE
                var skHid = Number(req.patronsId);
                var skId = Number(req.skillId);
                var skType = Number(req.type || 1);
                var skNum = Math.max(1, Number(req.num || 1));
                var skHero = st.heroes[skHid];
                var newLv = 1;
                if (skHero) {
                    skHero.skillList = skHero.skillList || [];
                    var found = null;
                    for (var si2 = 0; si2 < skHero.skillList.length; si2++) {
                        if (skHero.skillList[si2].skillId === skId) { found = skHero.skillList[si2]; break; }
                    }
                    if (found) {
                        found.skillLv = Number(found.skillLv || 1) + skNum;
                        newLv = found.skillLv;
                    } else {
                        newLv = 1 + skNum;
                        skHero.skillList.push({ skillId: skId, skillLv: newLv, type: skType });
                    }
                    st.heroSkillUpgradeCount = Number(st.heroSkillUpgradeCount || 0) + skNum;
                    recalcEarnSpeed(st);
                    saveState(st);
                    this._push(505, uid, { ret: 0, patronsId: skHid, skillId: skId, skillLv: newLv, type: skType });
                    this._push(502, uid, { patronsList: [skHero] });
                    this._pushTaskUpdates(st);
                } else {
                    this._push(505, uid, { ret: 0, patronsId: skHid, skillId: skId, skillLv: newLv, type: skType });
                }
                return;
            }
            case 20506: { // S_HERO_EQUIP_CAR
                var eqHero = st.heroes[Number(req.heroId)];
                var eqCar = st.cars[String(req.carId)];
                if (eqHero && eqCar) {
                    eqCar.heroId = eqHero.patronsId;
                    eqHero.carId = eqCar.templateId;
                    saveState(st);
                    this._push(506, uid, { ret: 0 });
                    this._push(502, uid, { patronsList: [eqHero] });
                    this._push(4202, uid, { carList: [eqCar] });
                } else {
                    this._push(506, uid, { ret: 0 });
                }
                return;
            }

            // ---------------- BEAUTIES / ARTISTS ----------------
            case 24303: { // S_BEAUTY_UPGRADE
                var bty = st.beauties[Number(req.beautyId)];
                if (bty) {
                    bty.level = Number(bty.level || 1) + 1;
                    bty.affinity = Number(bty.affinity || 0) + 10;
                    bty.influence = Number(bty.influence || 0) + 10;
                    recalcEarnSpeed(st);
                    saveState(st);
                    this._push(4303, uid, { ret: 0, beauty: bty });
                    this._push(4302, uid, { beautyList: [bty] });
                    this._pushEarnSpeed(st);
                } else {
                    this._push(4303, uid, { ret: 0 });
                }
                return;
            }
            case 24308: { // S_BEAUTY_PROPAGATE
                var bList = objValues(st.beauties);
                var propList = [];
                if (bList.length > 0) {
                    var targetB = bList[Math.floor(Math.random() * bList.length)];
                    targetB.affinity += 5;
                    targetB.influence += 5;
                    propList.push({ beautyId: targetB.beautyId, addAffinity: 5, addInfluence: 5, addFetterVal: 10 });
                }
                st.silver = addBigNumStr(st.silver, 500);
                saveState(st);
                this._push(4308, uid, { ret: 0, beautyPropagateList: propList });
                this._push(4307, uid, { energy: 10, lastRestoreTime: now });
                this._pushAttrs(st);
                return;
            }

            // ---------------- CARS ----------------
            case 24204: { // S_CAR_UPGRADE
                var car = st.cars[String(req.carId)];
                if (car) {
                    car.level = Number(car.level || 1) + Math.max(1, Number(req.times || 1));
                    saveState(st);
                    this._push(4204, uid, { ret: 0, car: car });
                    this._push(4202, uid, { carList: [car] });
                } else {
                    this._push(4204, uid, { ret: 0 });
                }
                return;
            }
            case 24208: { // S_CAR_BREAK
                var bcar = st.cars[String(req.carId)];
                if (bcar) {
                    bcar.breakLv = Number(bcar.breakLv || 0) + 1;
                    saveState(st);
                    this._push(4208, uid, { ret: 0, car: bcar });
                    this._push(4202, uid, { carList: [bcar] });
                } else {
                    this._push(4208, uid, { ret: 0 });
                }
                return;
            }

            // ---------------- TASKS / QUESTS ----------------
            case 21205: { // S_TASK_GET_REWARD
                var tid = Number(req.taskId);
                var task = st.tasks[tid];
                var dbUtilT = getDBUtil();
                var cfgT = (dbUtilT && dbUtilT.getTask) ? dbUtilT.getTask(tid) : null;
                if (task) {
                    task.state = 1; // received
                    task.finishTime = Math.floor(now / 1000);
                } else {
                    task = { taskId: tid, value: "1", state: 1, finishTime: Math.floor(now / 1000), taskStartTime: 0, taskEndTime: 0 };
                    st.tasks[tid] = task;
                }
                if (st.completeTaskIds.indexOf(tid) < 0) {
                    st.completeTaskIds.push(tid);
                }

                // If this is a type=22 business-unlock task, also attach businessId to the building
                var updatedBuildings = [];
                if (dbUtilT && dbUtilT.getStoreSetingListByBuildingId) {
                    for (var bKey in st.buildings) {
                        if (!st.buildings.hasOwnProperty(bKey)) continue;
                        var bObj = st.buildings[bKey];
                        var slT = [];
                        try { slT = dbUtilT.getStoreSetingListByBuildingId(Number(bKey)) || []; } catch (e) {}
                        for (var sIdx = 0; sIdx < slT.length; sIdx++) {
                            if (Number(slT[sIdx].unlockCondition) === tid) {
                                if (ensureBusinessInBuilding(bObj, slT[sIdx].id)) {
                                    updatedBuildings.push(bObj);
                                } else if (updatedBuildings.indexOf(bObj) < 0) {
                                    updatedBuildings.push(bObj);
                                }
                            }
                        }
                    }
                }

                if (cfgT && cfgT.rewards && cfgT.rewards !== "0") {
                    grantRewardString(st, cfgT.rewards);
                } else if (!cfgT || Number(cfgT.type) !== 22) {
                    grantItem(st, 101000, 500);
                    grantItem(st, 101002, 5);
                }
                var nextId = cfgT && cfgT.nextTaskId ? Number(cfgT.nextTaskId) : 0;
                var nextTaskObj = null;
                if (nextId > 0) {
                    if (!cfgT || Number(cfgT.type) === 2) {
                        st.mainTaskId = nextId;
                    }
                    nextTaskObj = evaluateTaskProgress(st, nextId) || {
                        taskId: nextId, value: "0", state: 0, finishTime: 0, taskStartTime: 0, taskEndTime: 0
                    };
                    st.tasks[nextId] = nextTaskObj;
                }
                var extraChangedTasks = updateAllActiveTasks(st);
                if (updatedBuildings.length > 0) recalcEarnSpeed(st);
                st.taskActive = Number(st.taskActive || 0) + 10;
                saveState(st);

                var respTask = { ret: 0, finishTime: Math.floor(now / 1000) };
                if (nextId > 0) {
                    respTask.nextTaskId = nextId;
                    respTask.nextTask = nextTaskObj;
                }
                this._push(1205, uid, respTask);
                this._push(1209, uid, { taskId: [tid], all: false });
                var syncList = [];
                if (task) syncList.push(task);
                if (nextTaskObj) syncList.push(nextTaskObj);
                for (var ei = 0; ei < extraChangedTasks.length; ei++) {
                    if (syncList.indexOf(extraChangedTasks[ei]) < 0) syncList.push(extraChangedTasks[ei]);
                }
                if (syncList.length > 0) this._push(1202, uid, { dataList: syncList });
                if (updatedBuildings.length > 0) {
                    this._push(405, uid, { buildingList: updatedBuildings });
                    this._pushEarnSpeed(st);
                }
                this._push(1203, uid, { taskActive: st.taskActive, rewardIndexList: st.taskActiveRewards || [] });
                this._pushAttrs(st);
                this._pushBag(st);
                return;
            }
            case 21208: { // S_TASK_ONE_KEY_GET_REWARD
                var ids = Array.isArray(req.taskId) ? req.taskId : [];
                for (var oi = 0; oi < ids.length; oi++) {
                    var tObj = st.tasks[Number(ids[oi])];
                    if (tObj) tObj.state = 1;
                }
                grantItem(st, 101000, 1000 * Math.max(1, ids.length));
                grantItem(st, 101001, 50 * Math.max(1, ids.length));
                saveState(st);
                this._push(1208, uid, { ret: 0, taskId: ids, reward: "101000=1000;101001=50" });
                this._pushAttrs(st);
                return;
            }

            // ---------------- BAG & ITEMS ----------------
            case 20602: { // S_BAG_USE_GOODS
                var gid = Number(req.goodsId);
                var cnt = Math.max(1, Number(req.count || 1));
                if (st.bag[gid]) {
                    st.bag[gid] = Math.max(0, Number(st.bag[gid]) - cnt);
                }
                var rew = "101000=" + (cnt * 10000);
                grantRewardString(st, rew);
                saveState(st);
                this._push(602, uid, { ret: 0, goodsId: gid, count: cnt, reward: rew, specialReward: false });
                this._pushBag(st);
                this._pushAttrs(st);
                return;
            }
            case 20603: { // S_BAG_COMPOSE
                var cgid = Number(req.goodsId);
                var ccnt = Math.max(1, Number(req.count || 1));
                this._push(603, uid, { ret: 0, composeGoodsId: cgid, composeCount: ccnt });
                this._pushBag(st);
                return;
            }

            // ---------------- SHOP ----------------
            case 24101: { // S_SHOP_GET_GOODS_LIST
                this._push(4101, uid, { ret: 0, shopType: Number(req.shopType || 1), shopGoodsList: [] });
                return;
            }
            case 24102: { // S_SHOP_BUY_GOODS
                var sgid = Number(req.shopGoodsId || 0);
                var scnt = Math.max(1, Number(req.count || 1));
                grantItem(st, 110001, scnt);
                saveState(st);
                this._push(4102, uid, { ret: 0, shopGoodsId: sgid, count: scnt, goodsDeatil: "110001=" + scnt });
                this._pushBag(st);
                this._pushAttrs(st);
                return;
            }

            // ---------------- MAIL ----------------
            case 20302: { // S_MAIL_READ_MAIL
                for (var mi = 0; mi < st.mails.length; mi++) {
                    if (st.mails[mi].mailUid === req.mailUid) {
                        st.mails[mi].isRead = true;
                        st.mails[mi].readTime = Math.floor(now / 1000);
                    }
                }
                saveState(st);
                this._push(302, uid, { ret: 0 });
                this._push(307, uid, { mailList: st.mails });
                return;
            }
            case 20303: // S_MAIL_GET_REWARD
            case 20304: { // S_MAIL_GET_ALL_REWARD
                var allRew = [];
                for (var mj = 0; mj < st.mails.length; mj++) {
                    var ml = st.mails[mj];
                    if (cmdId === 20304 || ml.mailUid === req.mailUid) {
                        if (!ml.isGetReward && ml.annexes) {
                            grantRewardString(st, ml.annexes);
                            allRew.push(ml.annexes);
                        }
                        ml.isRead = true;
                        ml.isGetReward = true;
                    }
                }
                saveState(st);
                if (cmdId === 20304) {
                    this._push(304, uid, { ret: 0, reward: allRew.join(";") });
                } else {
                    this._push(303, uid, { ret: 0 });
                }
                this._push(307, uid, { mailList: st.mails });
                this._pushAttrs(st);
                this._pushBag(st);
                return;
            }
            case 20305: // S_MAIL_DELETE_MAIL
            case 20306: { // S_MAIL_DELETE_ALL_MAIL
                if (cmdId === 20306) {
                    st.mails = st.mails.filter(function (m) { return !m.isGetReward; });
                } else {
                    st.mails = st.mails.filter(function (m) { return m.mailUid !== req.mailUid; });
                }
                saveState(st);
                this._push(recvId, uid, { ret: 0 });
                this._push(307, uid, { mailList: st.mails });
                return;
            }

            // ---------------- SIGN IN ----------------
            case 24852: { // S_SIGN_IN
                st.sign.currentSignDays = (st.sign.currentSignDays || 0) + 1;
                st.sign.totalSignDays = (st.sign.totalSignDays || 0) + 1;
                var signRew = "101001=200;101000=10000";
                grantRewardString(st, signRew);
                saveState(st);
                this._push(4852, uid, {
                    ret: 0,
                    signData: {
                        currentSignDays: st.sign.currentSignDays,
                        lastSignDays: st.sign.lastSignDays || 0,
                        totalSignDays: st.sign.totalSignDays,
                        gainedAccumulateIndex: st.sign.gainedAccumulateIndex || [],
                        cycleCount: st.sign.cycleCount || 1,
                        today: { items: [], lucks: [] },
                        yesterday: { items: [], lucks: [] }
                    },
                    reward: signRew
                });
                this._pushAttrs(st);
                return;
            }

            // ---------------- GENERIC AUTO-SCHEMA FALLBACK ----------------
            default: {
                var pbMgr = getProtobufMgr();
                if (pbMgr && pbMgr.cmdList && pbMgr.cmdList[cmdId] && pbMgr.cmdList[cmdId].smMethod) {
                    this._push(recvId, uid, { ret: 0 });
                }
                return;
            }
        }
    };

    global.WebSocket = OfflineWebSocket;

    // Export for Node.js E2E verification
    global.__GCXUA_OFFLINE_SERVER__ = {
        handleHttpRequest: handleHttpRequest,
        encodePacket: encodePacket,
        decodeClientPacket: decodeClientPacket,
        buildDefaultMessageObj: buildDefaultMessageObj,
        getState: getState,
        saveState: saveState,
        toRecvProtocol: toRecvProtocol,
        OfflineXMLHttpRequest: OfflineXMLHttpRequest,
        OfflineWebSocket: OfflineWebSocket
    };

    log("GocChoXua 3.7.1 Offline Server initialized cleanly.");
})(typeof window !== "undefined" ? window : global);
