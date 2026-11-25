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

    function getDBTable(tableName) {
        try {
            var dbMgr = getDBMgr();
            if (dbMgr && dbMgr.db && dbMgr.db[tableName]) {
                return dbMgr.db[tableName];
            }
        } catch (e) {}
        return null;
    }

    function getDBTableIds(tableName) {
        var tbl = getDBTable(tableName);
        var ids = [];
        if (!tbl) return ids;
        var dbUtil = getDBUtil();
        for (var k in tbl) {
            if (!Object.prototype.hasOwnProperty.call(tbl, k)) continue;
            if (dbUtil && typeof dbUtil.filterId === "function") {
                try { if (dbUtil.filterId(k)) continue; } catch (e) {}
            } else if (!/^\d+$/.test(k)) {
                continue;
            }
            var n = parseInt(k, 10);
            if (!isNaN(n) && n > 0) ids.push(n);
        }
        ids.sort(function (a, b) { return a - b; });
        return ids;
    }

    function getDBRow(tableName, id) {
        var tbl = getDBTable(tableName);
        if (!tbl) return null;
        return tbl[id] || tbl[String(id)] || null;
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

    function multiplyRewardString(str, mult) {
        var items = parseRewardString(str);
        var parts = [];
        mult = Math.max(1, Number(mult || 1));
        for (var i = 0; i < items.length; i++) {
            parts.push(items[i].id + "=" + (items[i].count * mult));
        }
        return parts.join(";");
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
    // 5. Player State Model, Dual-Server Max Tester & Persistence
    // =========================================================================
    var currentOpenId = "tiemtaphoa01";
    var currentServerId = 1; // 1 = Max Tester Lv60 VIP15 Full, 2 = Tân Thủ
    var stateCache = {};
    var activeWs = null;
    var pendingRechargeOrders = {};

    var GAME_TIMECOIN_ID = 101011; // Xu Thời Gian / Thẻ Giảm Giá (ConfigDB.GAME_TIMECOIN_ID)
    var DEFAULT_HEAD_ID = 106100;  // Valid LeadDecorateDB Avatar (female starter 1)
    var DEFAULT_COSTUME_ID = 106000; // Valid LeadDecorateDB Figure (female starter 1)
    var PLAYER_ROLE_DEFAULTS = {
        1: { costumeId: 106000, headId: 106100, sex: 2 },
        2: { costumeId: 106010, headId: 106110, sex: 1 },
        3: { costumeId: 106020, headId: 106120, sex: 2 },
        4: { costumeId: 106030, headId: 106130, sex: 1 },
        5: { costumeId: 106050, headId: 106150, sex: 1 },
        10: { costumeId: 106710, headId: 106730, sex: 1 }
    };

    function hashUserId(openId, serverId) {
        var h = 100001;
        var s = String(openId || "tiemtaphoa01") + "_s" + String(serverId || 1);
        for (var i = 0; i < s.length; i++) {
            h = ((h * 31) + s.charCodeAt(i)) % 900000;
        }
        return 100000 + Math.abs(h);
    }

    function getAllSystemIds() {
        var ids = getDBTableIds("SystemOpenDB");
        if (ids.length > 0) return ids;
        var list = [];
        for (var i = 1; i <= 400; i++) list.push(i);
        return list;
    }

    function createHeroObj(heroId, level, stageLv, breakLv, awakenLevel, now) {
        now = now || Date.now();
        level = Number(level || 1);
        stageLv = Number(stageLv || 1);
        breakLv = Number(breakLv || 0);
        awakenLevel = Number(awakenLevel || 0);
        var skills = [];
        var cfg = getDBRow("HeroDB", heroId);
        if (cfg && cfg.skill) {
            var sp = String(cfg.skill).split(/[;|,]/);
            for (var i = 0; i < sp.length; i++) {
                var sid = parseInt(sp[i], 10);
                if (!isNaN(sid) && sid > 0) {
                    skills.push({ skillId: sid, skillLv: Math.max(1, Math.min(10, Math.floor(level / 5) + 1)), type: 1 });
                }
            }
        }
        if (skills.length === 0) {
            skills = [
                { skillId: 10021, skillLv: Math.max(1, Math.floor(level / 5)), type: 1 },
                { skillId: 10031, skillLv: Math.max(1, Math.floor(level / 5)), type: 1 },
                { skillId: 10041, skillLv: Math.max(1, Math.floor(level / 5)), type: 1 }
            ];
        }
        var addAb = String(500 + level * 80 + stageLv * 300 + breakLv * 500);
        var sumAb = String(1500 + level * 350 + stageLv * 1200 + breakLv * 2500 + awakenLevel * 3000);
        return {
            patronsId: Number(heroId),
            level: level,
            stageLv: stageLv,
            breakLv: breakLv,
            skillList: skills,
            addAbility: addAb,
            tradeWarAddEarnSpeed: "0",
            skinId: 0,
            carId: 0,
            sumAbility: sumAb,
            promotionId: 0,
            awakenLevel: awakenLevel,
            expertLev: level >= 50 ? 5 : 0,
            addTime: Math.floor(now / 1000)
        };
    }

    function createBeautyObj(beautyId, level, affinity, influence, now) {
        now = now || Date.now();
        level = Number(level || 1);
        affinity = Number(affinity || 100);
        influence = Number(influence || 100);
        var cfg = getDBRow("BeautyDB", beautyId);
        var quality = cfg && cfg.quality ? Number(cfg.quality) : 2;
        return {
            beautyId: Number(beautyId),
            affinity: affinity,
            level: level,
            identitySkillLv: Math.max(1, Math.floor(level / 10) + 1),
            skillList: [
                { skillPos: 1, skillValue: 50 + level * 5, modifyNum: 0 },
                { skillPos: 2, skillValue: 50 + level * 5, modifyNum: 0 }
            ],
            isShow: true,
            createTime: now,
            influence: influence,
            fetterVal: Math.max(100, affinity),
            artVal: Math.max(100, influence),
            subSkillList: [],
            quality: quality,
            readVoice: [],
            voice: 0,
            playNum: 0,
            skinId: 0
        };
    }

    function createCarObj(carIdStr, templateId, level, breakLv, heroId, isShow) {
        var cfg = getDBRow("CarDB", templateId);
        var skillCnt = (cfg && cfg.defaultSkillCount) ? Math.max(1, Number(cfg.defaultSkillCount)) : 1;
        var skills = [];
        for (var s = 1; s <= skillCnt; s++) {
            skills.push({
                skillPos: s,
                skillType: 1,
                skillAttr: ((s - 1) % 4) + 1,
                value: 10 + Number(level || 1) * 5,
                skillModifyTimes: 0,
                randomSkillAttr: 0,
                randomValue: 0
            });
        }
        return {
            carId: String(carIdStr),
            templateId: Number(templateId),
            level: Number(level || 1),
            breakLv: Number(breakLv || 0),
            heroId: Number(heroId || 0),
            isShow: !!isShow,
            rank: 1,
            skillList: skills,
            equipNum: 1,
            status: 1,
            holeSkillList: [],
            skinId: 0,
            bindUniqueId: []
        };
    }

    function nextCarUid(st) {
        st._carSeq = Number(st._carSeq || 1000) + 1;
        return String(st._carSeq);
    }

    function createDefaultFishStore(isMax) {
        var areaIds = getDBTableIds("FishStoreAreaDB");
        if (areaIds.length === 0) areaIds = [1001, 1002, 1003, 1004, 1005, 1006];
        var fishIds = getDBTableIds("FishStoreFishDB");
        if (fishIds.length === 0) fishIds = [1001, 1002, 1003, 1004, 2001, 2002];
        var procIds = getDBTableIds("FishStoreProcessDB");
        if (procIds.length === 0) procIds = [1001, 1002, 1003, 1004];

        var areas = [];
        var maxAreas = isMax ? areaIds.length : Math.min(2, areaIds.length);
        for (var i = 0; i < maxAreas; i++) areas.push({ areaId: areaIds[i] });

        var fishes = [];
        var stockFishes = [];
        var maxFishes = isMax ? fishIds.length : Math.min(4, fishIds.length);
        for (var j = 0; j < maxFishes; j++) {
            fishes.push({ fishId: fishIds[j], level: isMax ? 10 : 1 });
            stockFishes.push({ fishId: fishIds[j], num: isMax ? 200 : 20 });
        }

        var processes = [];
        var maxProc = isMax ? procIds.length : Math.min(2, procIds.length);
        for (var k = 0; k < maxProc; k++) {
            processes.push({ processId: procIds[k], level: isMax ? 5 : 1 });
        }

        return {
            level: isMax ? 5 : 1,
            stockUp: isMax ? 10 : 1,
            stockUpPower: isMax ? 50 : 15,
            stock: { fishes: stockFishes },
            processes: processes,
            areas: areas,
            fishes: fishes,
            popularity: isMax ? 50000 : 500,
            saleFishNum: isMax ? 100 : 5,
            dailyPowerAddCount: 0,
            fishSaleCount: [],
            lastStockUpPowerTime: Date.now()
        };
    }

    function createDefaultHouses(isMax) {
        var houseIds = getDBTableIds("HouseDB");
        if (houseIds.length === 0) houseIds = [1001, 1002, 1003];
        var list = [];
        for (var i = 0; i < houseIds.length; i++) {
            var hid = houseIds[i];
            if (!isMax && i > 0) break;
            var hCfg = getDBRow("HouseDB", hid);
            var roomIds = [];
            if (hCfg && hCfg.room) {
                var rParts = String(hCfg.room).split(/[;|,]/);
                for (var r = 0; r < rParts.length; r++) {
                    var rid = parseInt(rParts[r], 10);
                    if (!isNaN(rid) && rid > 0) roomIds.push(rid);
                }
            }
            if (roomIds.length === 0) roomIds = [101, 102];
            var rooms = [];
            for (var j = 0; j < roomIds.length; j++) {
                rooms.push({
                    houseId: hid,
                    roomId: roomIds[j],
                    furnitureList: [],
                    isCleanUp: true,
                    cleanItems: [],
                    status: 1
                });
            }
            list.push({
                houseId: hid,
                furnitureNum: isMax ? 10 : 1,
                isShow: i === 0,
                roomList: rooms
            });
        }
        return list;
    }

    function createDefaultDanceHall(isMax) {
        var settingIds = getDBTableIds("DanceHallSettingDB");
        if (settingIds.length === 0) settingIds = [1000, 1001, 1002, 1003];
        var settings = [];
        for (var i = 0; i < settingIds.length; i++) {
            settings.push({ settingId: settingIds[i], level: isMax ? 5 : 1 });
        }
        return {
            level: isMax ? 5 : 1,
            energy: isMax ? 30 : 15,
            lastRecoverEnergyAt: Date.now(),
            setting: settings
        };
    }

    function createDefaultVideoHall(isMax) {
        var videoIds = getDBTableIds("VideoHallVideoDB");
        if (videoIds.length === 0) videoIds = [1001, 1002, 1003, 1004];
        var videos = [];
        for (var i = 0; i < videoIds.length; i++) {
            videos.push({ videoId: videoIds[i], level: isMax ? 5 : 1 });
        }
        return {
            level: isMax ? 5 : 1,
            energy: isMax ? 30 : 15,
            lastRecoverEnergyAt: Date.now(),
            areaId: isMax ? [1, 2, 3, 4] : [1],
            video: videos
        };
    }

    function createDefaultPromote(isMax) {
        var deptIds = getDBTableIds("PromoteDepartmentDB");
        if (deptIds.length === 0) deptIds = [1, 2, 3, 4];
        var depts = [];
        for (var i = 0; i < deptIds.length; i++) {
            depts.push({
                id: deptIds[i],
                count: isMax ? 20 : 1,
                level: isMax ? 5 : 1,
                middleReward: false,
                highReward: false,
                currentLvCount: isMax ? 5 : 0
            });
        }
        return {
            departmentInfo: depts,
            count: isMax ? 50 : 0,
            historyConsume: isMax ? "100000" : "0",
            addition: "100"
        };
    }

    function createDefaultTrain(isMax) {
        var seats = [];
        var cnt = isMax ? 10 : 4;
        for (var i = 1; i <= cnt; i++) {
            seats.push({
                seatId: i,
                heroId: 0,
                heroStartTime: 0,
                heroMaxEndTime: 0,
                completedMillis: 0
            });
        }
        return {
            level: isMax ? 5 : 1,
            seats: seats,
            lessons: [
                { lessonId: 1, skillLevel: isMax ? 5 : 1, totalStudyTimes: isMax ? 10 : 0 },
                { lessonId: 2, skillLevel: isMax ? 5 : 1, totalStudyTimes: isMax ? 10 : 0 },
                { lessonId: 3, skillLevel: isMax ? 5 : 1, totalStudyTimes: isMax ? 10 : 0 }
            ],
            heroInLesson: 0,
            lessonStartTime: 0,
            studyingLesson: 0,
            lessonTimes: 0,
            repute: isMax ? 50000 : 500
        };
    }

    function createDefaultTvStudios(st) {
        var now = Date.now();
        var beautyIds = Object.keys(st.beauties || {}).map(Number);
        if (beautyIds.length === 0) beautyIds = [103201];
        var scriptIds = getDBTableIds("TvStudioDB");
        if (scriptIds.length === 0) scriptIds = [107001, 107002, 107003, 107004, 107005];
        var studios = [];
        for (var i = 1; i <= 5; i++) {
            var leadId = beautyIds[(i - 1) % beautyIds.length];
            var scId = scriptIds[(i - 1) % scriptIds.length];
            studios.push({
                studioIndex: i,
                state: 1,
                scriptId: scId,
                name: "Kịch Bản Chợ Xưa " + i,
                shotNum: 10,
                lastRecoveryAt: now,
                beauties: [{ beautyId: leadId, isLead: true, pos: 1 }],
                originalLeadId: leadId,
                usePropExchange: false,
                progress: 0,
                qualityId: 1,
                earnSpeed: 500 * i,
                earnSpeedEffect: [],
                groupActor: [],
                shotCount: 0,
                specialLead: false,
                multiple: 1
            });
        }
        return {
            studios: studios,
            practiceRoomLevel: st.serverId === 1 ? 5 : 1,
            telecastNum: st.serverId === 1 ? 10 : 0
        };
    }

    function createInitialState(openId, serverId) {
        serverId = Number(serverId || currentServerId || 1);
        var isMax = (serverId === 1);
        var now = Date.now();
        var uid = hashUserId(openId, serverId);
        var st = {
            openId: openId,
            serverId: serverId,
            userId: uid,
            hasRole: isMax ? true : false,
            maxTesterApplied: false,
            maxTesterDbPopulated: false,
            nickName: isMax ? "Chủ Tiệm Max VIP15" : "Chủ Tiệm Xưa",
            sex: 2,
            headId: DEFAULT_HEAD_ID,
            costumeId: DEFAULT_COSTUME_ID,
            frameId: 0,
            titleDecoId: 0,
            bubbleId: 0,
            player: 1,
            changePlayerCount: 0,
            playerSign: isMax
                ? "Tài khoản Max Tester Lv60 • VIP 15 • Full Nhân Tài/Xe/Nghệ Sĩ/Skin & Thẻ Giảm Giá Vô Hạn!"
                : "Chào mừng đến Góc Chợ Xưa Offline!",
            titleId: isMax ? 60 : 1,
            vipExp: isMax ? 99999999 : 5000,
            vipRewardedLevels: [],
            ingots: isMax ? 999999999 : 99999,
            silver: isMax ? "9999999999999" : "500000",
            patronsExp: isMax ? "999999999999" : "100000",
            prestige: isMax ? "999999999" : "50",
            rechargeToken: 999999999,
            earnSpeed: isMax ? "9999999" : "100",
            registerTime: now,
            lastLoginTime: now,
            lastTickTime: now,
            getTitleRewardTime: 0,
            loginTotalDays: isMax ? 30 : 1,
            guideId: isMax ? 99999 : 0,
            guideParam: "",
            clientStates: {},
            vnSaveParam: "{}",
            openSystems: getAllSystemIds(),
            buildings: {
                15101: {
                    buildingId: 15101,
                    level: isMax ? 50 : 1,
                    expendlevel: isMax ? 5 : 0,
                    buildingStatus: 2,
                    cleanItemList: [],
                    heroIdList: [102210],
                    businessList: [{ businessId: 10101, status: 0 }],
                    buildingName: "",
                    questionNum: 3,
                    autoSwitch: 1,
                    openTime: now
                }
            },
            buildingServeCounts: { 15101: 0 },
            _carSeq: 1001,
            heroes: {
                102210: createHeroObj(102210, isMax ? 60 : 10, isMax ? 5 : 1, isMax ? 5 : 0, isMax ? 5 : 0, now),
                102240: createHeroObj(102240, isMax ? 60 : 1, isMax ? 5 : 1, isMax ? 5 : 0, isMax ? 5 : 0, now)
            },
            beauties: {
                103201: createBeautyObj(103201, isMax ? 60 : 1, isMax ? 10000 : 100, isMax ? 10000 : 100, now)
            },
            beautyEnergy: isMax ? 30 : 10,
            beautyEnergyTime: now,
            cars: {
                "1001": createCarObj("1001", 104001, isMax ? 30 : 1, isMax ? 3 : 0, 102210, true)
            },
            carTemplates: [104001],
            skins: {},
            playerSkins: [],
            decorations: {},
            bag: {
                101011: 999999999, // GAME_TIMECOIN_ID (Thẻ Giảm Giá / Xu Thời Gian)
                110001: 9999,
                110002: 9999,
                110008: 9999,
                110009: 9999,
                110010: 9999,
                110040: 9999,
                119001: 999
            },
            mainTaskId: 200001,
            tasks: {
                200001: { taskId: 200001, value: "1", state: 0, finishTime: 0, taskStartTime: 0, taskEndTime: 0 },
                100001: { taskId: 100001, value: "1", state: 0, finishTime: 0, taskStartTime: 0, taskEndTime: 0 },
                2201101: { taskId: 2201101, value: "1", state: 1, finishTime: Math.floor(now / 1000), taskStartTime: 0, taskEndTime: 0 }
            },
            completeTaskIds: [2201101],
            buildingHandleDetails: {},
            heroSkillUpgradeCount: isMax ? 50 : 0,
            workshop: {
                workshopId: isMax ? 10 : 1,
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
                maxWorkshopId: 500
            },
            taskActive: isMax ? 150 : 10,
            taskActiveRewards: [],
            sevenDayActive: isMax ? 150 : 10,
            sevenDayRewards: [],
            road: {
                passId: isMax ? 10 : 1,
                passProgress: 0,
                buyBuffTimes: 0,
                itemBuyBuffTimes: 0,
                events: [],
                maxPassId: 100
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
                    mailUid: "offline_welcome_v4",
                    mailType: 1,
                    title: isMax ? "Chào mừng đến Max Tester Lv60 VIP 15!" : "Chào mừng đến Góc Chợ Xưa Offline!",
                    content: isMax
                        ? "Tài khoản Max Tester đã mở khóa Lv60, VIP15, Full Nhân Tài, Xe Cộ, Nghệ Sĩ, Skin, toàn bộ tính năng & vô hạn Thẻ Giảm Giá để kiểm tra mọi tính năng!"
                        : "Server Offline v4 đã fix toàn bộ lỗi! Mẹo: nhập mã MAX60, RICH, hoặc ALLHERO trong Cài đặt -> Đổi quà để nhận thêm tài nguyên!",
                    annexes: "101000=1000000;101001=50000;101011=999999;110001=100",
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
            customers: createDefaultCustomers(),
            houses: createDefaultHouses(isMax),
            houseComfortLevel: isMax ? 20 : 1,
            houseComfortValue: isMax ? 50000 : 100,
            fishStore: createDefaultFishStore(isMax),
            danceHall: createDefaultDanceHall(isMax),
            videoHall: createDefaultVideoHall(isMax),
            promote: createDefaultPromote(isMax),
            train: createDefaultTrain(isMax),
            tvStudio: null,
            happy52: {
                myRank: isMax ? 5 : 50,
                myMaxRank: isMax ? 5 : 50,
                remainDailyChallengeCount: 20,
                dailyReward: 0,
                claimedRanks: []
            },
            bizWar: {
                level: isMax ? 10 : 1,
                bussLevel: isMax ? 10 : 1,
                score: isMax ? 5000 : 100,
                bussWarMoney: isMax ? 50000 : 500,
                frequency: 20,
                lastGetRewardTime: 0,
                activeBattle: null
            },
            lottery: {
                luckyValue: 0,
                records: []
            },
            newbieTarget: {
                stageId: 1,
                startAt: Math.floor(now / 1000),
                submit: false,
                historyIncome: isMax ? "999999999" : "500000"
            },
            privileges: {
                1: { privilegedType: 1, day: 365, canGetReward: true, endTime: now + 365 * 86400000 },
                2: { privilegedType: 2, day: 365, canGetReward: true, endTime: now + 365 * 86400000 },
                3: { privilegedType: 3, day: 9999, canGetReward: true, endTime: now + 3650 * 86400000 },
                4: { privilegedType: 4, day: 365, canGetReward: true, endTime: now + 365 * 86400000 }
            },
            rechargeGained: {},
            shopBought: {},
            usedCodes: {}
        };
        st.heroes[102210].carId = 104001;
        st.tvStudio = createDefaultTvStudios(st);
        if (isMax) {
            populateMaxTesterState(st);
        }
        return st;
    }

    function ensureInfiniteVouchers(st) {
        st.bag = st.bag || {};
        st.rechargeToken = Math.max(999999999, Number(st.rechargeToken || 0));
        st.bag[GAME_TIMECOIN_ID] = Math.max(999999999, Number(st.bag[GAME_TIMECOIN_ID] || 0));
        var itemTbl = getDBTable("ItemDB");
        if (itemTbl) {
            var itemIds = getDBTableIds("ItemDB");
            for (var i = 0; i < itemIds.length; i++) {
                var row = itemTbl[itemIds[i]];
                if (!row) continue;
                var itype = Number(row.itemType || 0);
                if (itype === 133 || itype === 138) {
                    if (Number(st.bag[itemIds[i]] || 0) < 999999) {
                        st.bag[itemIds[i]] = 999999;
                    }
                }
            }
        }
    }

    function populateMaxTesterState(st) {
        var now = Date.now();
        var hasDb = !!getDBTable("HeroDB");
        st.hasRole = true;
        st.titleId = Math.max(60, Number(st.titleId || 60));
        st.vipExp = Math.max(99999999, Number(st.vipExp || 0));
        st.ingots = Math.max(999999999, Number(st.ingots || 0));
        if (Number(st.silver || 0) < 999999999999) st.silver = "9999999999999";
        if (Number(st.patronsExp || 0) < 99999999999) st.patronsExp = "999999999999";
        if (Number(st.prestige || 0) < 99999999) st.prestige = "999999999";
        st.rechargeToken = 999999999;
        st.openSystems = getAllSystemIds();
        st.guideId = Math.max(99999, Number(st.guideId || 0));

        // 1. Unlock ALL Heroes from HeroDB
        var heroIds = getDBTableIds("HeroDB");
        if (heroIds.length === 0) {
            heroIds = [102210, 102220, 102230, 102240, 102211, 102221, 102231, 102241, 102212, 102222];
        }
        st.heroes = st.heroes || {};
        for (var hi = 0; hi < heroIds.length; hi++) {
            var hid = heroIds[hi];
            if (!st.heroes[hid]) {
                st.heroes[hid] = createHeroObj(hid, 60, 5, 5, 5, now);
            } else if (Number(st.heroes[hid].level || 1) < 60) {
                st.heroes[hid].level = 60;
                st.heroes[hid].stageLv = Math.max(5, Number(st.heroes[hid].stageLv || 1));
                st.heroes[hid].breakLv = Math.max(5, Number(st.heroes[hid].breakLv || 0));
                st.heroes[hid].awakenLevel = Math.max(5, Number(st.heroes[hid].awakenLevel || 0));
            }
        }

        // 2. Unlock ALL Beauties from BeautyDB
        var beautyIds = getDBTableIds("BeautyDB");
        if (beautyIds.length === 0) {
            beautyIds = [103201, 103202, 103203, 103204, 103205, 103206, 103207, 103208];
        }
        st.beauties = st.beauties || {};
        for (var bi = 0; bi < beautyIds.length; bi++) {
            var btid = beautyIds[bi];
            if (!st.beauties[btid]) {
                st.beauties[btid] = createBeautyObj(btid, 60, 10000, 10000, now);
            }
        }
        st.beautyEnergy = Math.max(30, Number(st.beautyEnergy || 30));

        // 3. Unlock ALL Cars from CarDB (with valid skinId: 0, status: 1)
        var carTplIds = getDBTableIds("CarDB");
        if (carTplIds.length === 0) {
            carTplIds = [104001, 104002, 104003, 104004, 104005, 104006];
        }
        st.cars = st.cars || {};
        var ownedTemplates = {};
        for (var ck in st.cars) {
            if (st.cars.hasOwnProperty(ck)) ownedTemplates[Number(st.cars[ck].templateId)] = ck;
        }
        st.carTemplates = carTplIds.slice();
        for (var ci = 0; ci < carTplIds.length; ci++) {
            var cTpl = carTplIds[ci];
            if (!ownedTemplates[cTpl]) {
                var cid = nextCarUid(st);
                var assignHero = (ci < heroIds.length && st.heroes[heroIds[ci]] && !st.heroes[heroIds[ci]].carId)
                    ? heroIds[ci] : 0;
                st.cars[cid] = createCarObj(cid, cTpl, 30, 3, assignHero, ci === 0);
                if (assignHero && st.heroes[assignHero]) {
                    st.heroes[assignHero].carId = cTpl;
                }
            }
        }

        // 4. Unlock ALL Main Buildings from MainBuildingDB
        var bIds = getDBTableIds("MainBuildingDB");
        if (bIds.length === 0) bIds = [15101, 15102, 15103, 15104, 15105, 15106];
        st.buildings = st.buildings || {};
        for (var mbi = 0; mbi < bIds.length; mbi++) {
            var mbid = bIds[mbi];
            if (!st.buildings[mbid]) {
                st.buildings[mbid] = {
                    buildingId: mbid,
                    level: 50,
                    expendlevel: 5,
                    buildingStatus: 2,
                    cleanItemList: [],
                    heroIdList: mbi < heroIds.length ? [heroIds[mbi]] : [],
                    businessList: [],
                    buildingName: "",
                    questionNum: 3,
                    autoSwitch: 1,
                    openTime: now
                };
            } else {
                st.buildings[mbid].buildingStatus = 2;
                st.buildings[mbid].level = Math.max(50, Number(st.buildings[mbid].level || 1));
                st.buildings[mbid].expendlevel = Math.max(5, Number(st.buildings[mbid].expendlevel || 0));
            }
        }

        // 5. Unlock ALL Skins from SkinDB (Hero, Beauty, Player)
        var skinTbl = getDBTable("SkinDB");
        st.skins = st.skins || {};
        st.playerSkins = st.playerSkins || [];
        if (skinTbl) {
            var skinIds = getDBTableIds("SkinDB");
            for (var si = 0; si < skinIds.length; si++) {
                var sid = skinIds[si];
                var sRow = skinTbl[sid];
                if (!sRow) continue;
                var roleId = Number(sRow.belongRole || sRow.roleId || sRow.ownerId || sRow.targetId || 0);
                var sType = Number(sRow.type || 0);
                if (sType === 3 || sType === 4 || roleId === 0 || roleId < 1000) {
                    if (st.playerSkins.indexOf(sid) < 0) st.playerSkins.push(sid);
                } else {
                    if (!st.skins[roleId]) st.skins[roleId] = { dressingSkinId: 0, skinIds: [] };
                    if (st.skins[roleId].skinIds.indexOf(sid) < 0) st.skins[roleId].skinIds.push(sid);
                }
            }
        }

        // 6. Unlock ALL Decorations from LeadDecorateDB (Avatars, Frames, Figures, Titles, Bubbles)
        var decoIds = getDBTableIds("LeadDecorateDB");
        st.decorations = st.decorations || {};
        if (decoIds.length === 0) {
            decoIds = [106000, 106010, 106020, 106030, 106100, 106110, 106120, 106130];
        }
        for (var di = 0; di < decoIds.length; di++) {
            var did = decoIds[di];
            if (!st.decorations[did]) {
                st.decorations[did] = { decorationId: did, endTime: 0, modifyTime: Math.floor(now / 1000), status: 1 };
            }
        }

        // 7. Fill ALL Items from ItemDB + Infinite Vouchers / Thẻ Giảm Giá
        var itemTbl = getDBTable("ItemDB");
        st.bag = st.bag || {};
        if (itemTbl) {
            var itemIds = getDBTableIds("ItemDB");
            for (var ii = 0; ii < itemIds.length; ii++) {
                var iid = itemIds[ii];
                var iRow = itemTbl[iid];
                if (!iRow) continue;
                var itype = Number(iRow.itemType || 0);
                var minQty = (itype === 133 || itype === 138 || iid === GAME_TIMECOIN_ID) ? 999999 : 9999;
                if (Number(st.bag[iid] || 0) < minQty) {
                    st.bag[iid] = minQty;
                }
            }
        }
        ensureInfiniteVouchers(st);

        // 8. Refresh Houses, FishStore, DanceHall, VideoHall, Promote, Train, TvStudio with full DB tables
        if (hasDb && !st.maxTesterDbPopulated) {
            st.houses = createDefaultHouses(true);
            st.fishStore = createDefaultFishStore(true);
            st.danceHall = createDefaultDanceHall(true);
            st.videoHall = createDefaultVideoHall(true);
            st.promote = createDefaultPromote(true);
            st.train = createDefaultTrain(true);
            st.tvStudio = createDefaultTvStudios(st);
            st.maxTesterDbPopulated = true;
        }

        // 9. Mark GuideBook tasks ready to claim
        st.tasks = st.tasks || {};
        for (var gTid = 2300001; gTid <= 2300041; gTid++) {
            if (!st.tasks[gTid]) {
                st.tasks[gTid] = { taskId: gTid, value: "1", state: 0, finishTime: 0, taskStartTime: 0, taskEndTime: 0 };
            } else if (st.tasks[gTid].state === 0) {
                st.tasks[gTid].value = "1";
            }
        }
        // Seed Daily & Achievement tasks from TaskDB so bottom-right buttons are full & claimable
        var taskTbl = getDBTable("TaskDB");
        if (taskTbl) {
            var taskIds = getDBTableIds("TaskDB");
            for (var ti = 0; ti < taskIds.length; ti++) {
                var tId = taskIds[ti];
                var tRow = taskTbl[tId];
                if (!tRow) continue;
                var tType = Number(tRow.type || 0);
                if (tType === 1 || tType === 3 || tType === 4 || tType === 23) {
                    if (!st.tasks[tId]) {
                        var tParams = String(tRow.completeParams || "0|0|0|1").split("|");
                        var tTarget = parseInt(tParams[3] || "1", 10) || 1;
                        st.tasks[tId] = {
                            taskId: tId,
                            value: String(tTarget),
                            state: 0,
                            finishTime: 0,
                            taskStartTime: 0,
                            taskEndTime: 0
                        };
                    }
                }
            }
        }
        st.maxTesterApplied = true;
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

                if (reqLv <= 1 || st.serverId === 1) {
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

    function createDefaultCustomers() {
        var map = {};
        for (var cid = 108001; cid <= 108057; cid++) {
            map[cid] = { customerId: cid, status: 2 };
        }
        return map;
    }

    function buildCustomerList(st) {
        var list = [];
        if (!st || !st.customers) return list;
        for (var cid in st.customers) {
            if (st.customers.hasOwnProperty(cid)) {
                var c = st.customers[cid];
                list.push({
                    customerId: Number(c.customerId || cid),
                    status: Number(c.status !== undefined ? c.status : 2)
                });
            }
        }
        return list;
    }

    // Bug 3 & 6 Fix: Real 10-step WorkshopConfigData (never 1/1 or "Ải mới — Vui lòng đón chờ!")
    function buildWorkshopConfig(wid) {
        wid = Math.max(1, Number(wid || 1));
        var dbUtil = getDBUtil();
        if (dbUtil && typeof dbUtil.getWorkshop === "function") {
            try {
                var cfg = dbUtil.getWorkshop(wid, false);
                if (cfg && cfg.id && Number(cfg.num || 0) > 1) {
                    return {
                        id: Number(cfg.id),
                        num: Number(cfg.num || 10),
                        chapter: Number(cfg.chapter || Math.floor((wid - 1) / 10) + 1),
                        section: Number(cfg.section || ((wid - 1) % 10) + 1),
                        workshopTemplate: Number(cfg.workshopTemplate || ((wid - 1) % 6) + 1),
                        bossAbility: Number(cfg.bossAbility || 500 * wid),
                        bossExpReward: Number(cfg.bossExpReward || 200 * wid),
                        bossPrestige: Number(cfg.bossPrestige || 20 * wid),
                        completeReward: String(cfg.completeReward || ("101000=" + (2000 * wid) + ";101002=" + (25 * wid))),
                        baseInspireConsume: String(cfg.baseInspireConsume || ("101000=" + (100 * wid))),
                        onhookExp: Number(cfg.onhookExp || 20 * wid),
                        levelUnlock: String(cfg.levelUnlock || "0"),
                        addition: Number(cfg.addition || 10 * wid),
                        exAddition: Number(cfg.exAddition || 5 * wid),
                        moneyList: String(cfg.moneyList || "100;120;140;160;180;200;220;240;260;300"),
                        abilityList: String(cfg.abilityList || "100;120;140;160;180;200;220;240;260;300"),
                        expReward: String(cfg.expReward || "50;60;70;80;90;100;110;120;130;150"),
                        prestige: String(cfg.prestige || "5;5;6;6;7;7;8;8;9;10"),
                        eventsId: String(cfg.eventsId || "0"),
                        bossFigure: String(cfg.bossFigure || "102210")
                    };
                }
            } catch (e) {}
        }
        var steps = 10;
        var moneyArr = [];
        var abilArr = [];
        var expArr = [];
        var presArr = [];
        var baseMoney = 100 * wid;
        var baseAbil = 120 * wid;
        var baseExp = 60 * wid;
        var basePres = 5 + Math.floor(wid / 2);
        for (var i = 1; i <= steps; i++) {
            moneyArr.push(String(Math.floor(baseMoney * (1 + i * 0.15))));
            abilArr.push(String(Math.floor(baseAbil * (1 + i * 0.15))));
            expArr.push(String(Math.floor(baseExp * (1 + i * 0.1))));
            presArr.push(String(basePres + i));
        }
        return {
            id: wid,
            num: steps,
            chapter: Math.floor((wid - 1) / 10) + 1,
            section: ((wid - 1) % 10) + 1,
            workshopTemplate: ((wid - 1) % 6) + 1,
            bossAbility: Math.floor(baseAbil * 3),
            bossExpReward: Math.floor(baseExp * 5),
            bossPrestige: basePres * 5,
            completeReward: "101000=" + (2500 * wid) + ";101002=" + (20 * wid) + ";101003=" + (500 * wid),
            baseInspireConsume: "101000=" + (100 * wid),
            onhookExp: 25 * wid,
            levelUnlock: "0",
            addition: 15 * wid,
            exAddition: 5 * wid,
            moneyList: moneyArr.join(";"),
            abilityList: abilArr.join(";"),
            expReward: expArr.join(";"),
            prestige: presArr.join(";"),
            eventsId: "0",
            bossFigure: "102210"
        };
    }

    function buildWorkshopStandardConfig(wid) {
        wid = Math.max(1, Number(wid || 1));
        return {
            id: wid,
            workshopNeedTimes: 10,
            workerNeedTimes: 5,
            money: 100 * wid,
            ability: 120 * wid,
            exp: 60 * wid,
            prestige: 5 + wid
        };
    }

    // Bug 4 & 8 Fix: Real SyncHeroAbilityListMsg (S2C 510) so HeroMgr.getFinalAbilityValue() > 0 and Lệ Bình never throws!
    function buildHeroAbilityList(st) {
        var list = [];
        if (!st || !st.heroes) return list;
        var carByHero = {};
        for (var cid in (st.cars || {})) {
            if (st.cars.hasOwnProperty(cid)) {
                var c = st.cars[cid];
                if (c && Number(c.heroId || 0) > 0) carByHero[Number(c.heroId)] = c;
            }
        }
        var skinCount = 0;
        for (var sk in (st.skins || {})) {
            if (st.skins.hasOwnProperty(sk) && st.skins[sk].skinIds) skinCount += st.skins[sk].skinIds.length;
        }
        var beautyBonus = Object.keys(st.beauties || {}).length * 50;

        for (var hidKey in st.heroes) {
            if (!st.heroes.hasOwnProperty(hidKey)) continue;
            var h = st.heroes[hidKey];
            var hid = Number(h.patronsId || hidKey);
            var lv = Math.max(1, Number(h.level || 1));
            var stage = Math.max(1, Number(h.stageLv || 1));
            var brk = Math.max(0, Number(h.breakLv || 0));
            var awk = Math.max(0, Number(h.awakenLevel || 0));
            var cfg = getDBRow("HeroDB", hid);
            var initQual = (cfg && cfg.qualification) ? Number(cfg.qualification) : 12;
            var skillQual = 0;
            if (Array.isArray(h.skillList)) {
                for (var si = 0; si < h.skillList.length; si++) {
                    skillQual += Math.max(1, Number(h.skillList[si].skillLv || 1)) * 3;
                }
            }
            var eqCar = carByHero[hid];
            var carQual = eqCar ? (10 + Number(eqCar.level || 1) * 3 + Number(eqCar.breakLv || 0) * 5) : 0;
            var breakQual = brk * 8 + awk * 12;
            var stageQual = stage * 5;
            var totalQual = Math.max(10, initQual + skillQual + carQual + breakQual + stageQual);
            var baseAbil = Math.floor(totalQual * (100 + lv * 35) + Number(h.addAbility || 0));
            var carAddRate = eqCar ? (500 + Number(eqCar.level || 1) * 50) : 0;
            var stageRate = stage * 200;
            var beautyRate = Math.min(5000, beautyBonus);
            var sumAbil = Math.floor(baseAbil * (1 + (carAddRate + stageRate + beautyRate) / 10000));
            h.sumAbility = String(sumAbil);

            list.push({
                heroId: hid,
                heroBaseAbility: baseAbil,
                qualification: totalQual,
                heroLevel: lv,
                qualificationDetail: {
                    others: 0,
                    initValue: initQual,
                    skillValue: skillQual,
                    carValue: carQual,
                    breakValue: breakQual,
                    beautyValue: Math.min(100, Object.keys(st.beauties || {}).length * 2),
                    playerSkinValue: Math.min(100, (st.playerSkins ? st.playerSkins.length : 0)),
                    farmlandValue: 0,
                    successRoadValue: 0,
                    haloValue: 0,
                    furnitureValue: 0,
                    bathHallValue: 0,
                    directorateValue: 0,
                    landValue: 0,
                    heroJobValue: 0,
                    heroExpertValue: Number(h.expertLev || 0) * 5,
                    eudemonValue: 0,
                    itemAddTalentValue: 0,
                    linkValue: 0,
                    stageValue: stageQual,
                    contractValue: 0,
                    clothValue: 0,
                    heroReverieValue: 0
                },
                otherFix: 0,
                otherRate: 0,
                carAddRate: carAddRate,
                stagePercentAddRate: stageRate,
                beautyRelationPercentAddRate: beautyRate,
                stageFixValue: stage * 200,
                itemAddValue: Number(h.addAbility || 0),
                skinBondsAddValue: skinCount * 10
            });
        }
        return list;
    }

    function buildDecorationList(st) {
        var nowSec = Math.floor(Date.now() / 1000);
        st.decorations = st.decorations || {};
        // Always guarantee starter valid avatars & figures exist
        var baseIds = [106000, 106010, 106020, 106030, 106100, 106110, 106120, 106130];
        for (var i = 0; i < baseIds.length; i++) {
            if (!st.decorations[baseIds[i]]) {
                st.decorations[baseIds[i]] = { decorationId: baseIds[i], endTime: 0, modifyTime: nowSec, status: 1 };
            }
        }
        return objValues(st.decorations);
    }

    function buildSkinInfoMsg(st) {
        var roleSkinInfos = [];
        st.skins = st.skins || {};
        for (var rid in st.skins) {
            if (!st.skins.hasOwnProperty(rid)) continue;
            var entry = st.skins[rid];
            var sInfos = [];
            var ids = entry.skinIds || [];
            for (var i = 0; i < ids.length; i++) {
                sInfos.push({ skinId: Number(ids[i]), level: 1, skills: [] });
            }
            roleSkinInfos.push({
                roleId: Number(rid),
                dressingSkinId: Number(entry.dressingSkinId || 0),
                skinInfos: sInfos
            });
        }
        var foreverPlayer = [];
        var pIds = st.playerSkins || [];
        for (var j = 0; j < pIds.length; j++) {
            foreverPlayer.push({ skinId: Number(pIds[j]), level: 1, skills: [] });
        }
        return {
            roleSkinInfos: roleSkinInfos,
            foreverPlayerSkinInfos: foreverPlayer,
            limitPlayerSkinInfos: [],
            specialSkills: []
        };
    }

    function buildPrivilegeList(st) {
        var now = Date.now();
        st.privileges = st.privileges || {
            1: { privilegedType: 1, day: 365, canGetReward: true, endTime: now + 365 * 86400000 },
            2: { privilegedType: 2, day: 365, canGetReward: true, endTime: now + 365 * 86400000 },
            3: { privilegedType: 3, day: 9999, canGetReward: true, endTime: now + 3650 * 86400000 },
            4: { privilegedType: 4, day: 365, canGetReward: true, endTime: now + 365 * 86400000 }
        };
        return objValues(st.privileges);
    }

    function buildPlayerBrief(st, overrides) {
        overrides = overrides || {};
        var deco = JSON.stringify({
            1: overrides.headId || st.headId || DEFAULT_HEAD_ID,
            3: overrides.costumeId || st.costumeId || DEFAULT_COSTUME_ID
        });
        return {
            userAliasId: overrides.userId || st.userId,
            nickName: overrides.nickName || st.nickName || "Chủ Tiệm Xưa",
            titleId: overrides.titleId || st.titleId || 1,
            decoration: deco,
            unionName: "",
            unionUid: "",
            unionAliasId: 0,
            vipExp: overrides.vipExp !== undefined ? overrides.vipExp : (st.vipExp || 0),
            sex: overrides.sex || st.sex || 2,
            earnSpeed: String(overrides.earnSpeed || st.earnSpeed || "100"),
            registerTime: st.registerTime || Date.now(),
            serverId: st.serverId || 1,
            country: "VN",
            province: "Hà Nội",
            city: "Hà Nội",
            lastLoginTime: Date.now(),
            prestige: String(overrides.prestige || st.prestige || "0"),
            sign: String(st.playerSign || ""),
            userId: overrides.userId || st.userId,
            player: overrides.player || st.player || 1,
            openServerDay: Math.max(1, st.loginTotalDays || 1)
        };
    }

    function buildNpcOpponents(st, count) {
        count = count || 5;
        var npcNames = [
            "Tỷ Phú Ba Sài Gòn", "Bà Tư Vải Vóc", "Ông Năm Quán Phở",
            "Cô Sáu Chợ Bến Thành", "Đại Gia Bảy Tạp Hóa", "Chú Tám Bánh Mì"
        ];
        var list = [];
        var baseEarn = Math.max(500, Math.floor(Number(st.earnSpeed || 1000) * 0.6));
        for (var i = 0; i < count; i++) {
            var npcId = 900001 + i;
            var roleIdx = (i % 4) + 1;
            var rd = PLAYER_ROLE_DEFAULTS[roleIdx] || PLAYER_ROLE_DEFAULTS[1];
            list.push({
                id: npcId,
                npc: true,
                playerBaseData: buildPlayerBrief(st, {
                    userId: npcId,
                    nickName: npcNames[i % npcNames.length],
                    titleId: Math.max(1, Math.min(55, (st.titleId || 10) - 2 + i)),
                    headId: rd.headId,
                    costumeId: rd.costumeId,
                    sex: rd.sex,
                    player: roleIdx,
                    vipExp: 5000 * (i + 1),
                    earnSpeed: String(Math.floor(baseEarn * (0.5 + i * 0.2)))
                }),
                rank: Math.max(1, (st.happy52 ? st.happy52.myRank : 10) - (i + 1)),
                earnSpeed: Math.floor(baseEarn * (0.5 + i * 0.2))
            });
        }
        return list;
    }

    function migrateState(st) {
        if (!st) return st;
        var now = Date.now();
        var isMax = (Number(st.serverId || 1) === 1);
        // Bug 1 & 7.2 Fix: repair invalid legacy 10001 / 100100 LeadDecorate IDs
        if (!st.headId || st.headId === 10001 || st.headId < 106000) {
            st.headId = DEFAULT_HEAD_ID;
        }
        if (!st.costumeId || st.costumeId === 100100 || st.costumeId < 106000) {
            st.costumeId = DEFAULT_COSTUME_ID;
        }
        if (!st.player || st.player < 1) st.player = 1;
        if (!st.openSystems || st.openSystems.length < 200) {
            st.openSystems = getAllSystemIds();
        }
        if (!st.completeTaskIds) st.completeTaskIds = [];
        if (!st.buildingHandleDetails) st.buildingHandleDetails = {};
        if (!st.buildingServeCounts) st.buildingServeCounts = { 15101: 0 };
        if (st.heroSkillUpgradeCount === undefined) st.heroSkillUpgradeCount = 0;
        if (!st.vipRewardedLevels) st.vipRewardedLevels = [];
        if (!st.rechargeGained) st.rechargeGained = {};
        if (!st.skins) st.skins = {};
        if (!st.playerSkins) st.playerSkins = [];
        if (!st.decorations) st.decorations = {};
        if (!st.carTemplates) st.carTemplates = [];

        // Bug 10.1 Fix: normalize every car to have skinId: 0, bindUniqueId: [], holeSkillList: [], status: 1
        if (st.cars) {
            var newCars = {};
            var idx = 0;
            for (var ck in st.cars) {
                if (!st.cars.hasOwnProperty(ck)) continue;
                var c = st.cars[ck];
                if (!c) continue;
                idx++;
                var fixedCid = String(c.carId || ck);
                if (fixedCid.indexOf("car_") === 0) fixedCid = String(1000 + idx);
                c.carId = fixedCid;
                if (c.skinId === undefined || c.skinId === null) c.skinId = 0;
                if (!Array.isArray(c.bindUniqueId)) c.bindUniqueId = [];
                if (!Array.isArray(c.holeSkillList)) c.holeSkillList = [];
                if (!c.status) c.status = 1;
                if (!Array.isArray(c.skillList) || c.skillList.length === 0) {
                    c.skillList = [{ skillPos: 1, skillType: 1, skillAttr: 1, value: 10, skillModifyTimes: 0, randomSkillAttr: 0, randomValue: 0 }];
                }
                if (st.carTemplates.indexOf(Number(c.templateId)) < 0) {
                    st.carTemplates.push(Number(c.templateId));
                }
                newCars[fixedCid] = c;
            }
            st.cars = newCars;
        }

        if (!st.customers || Object.keys(st.customers).length === 0) {
            st.customers = createDefaultCustomers();
        } else {
            for (var cid = 108001; cid <= 108057; cid++) {
                if (!st.customers[cid]) st.customers[cid] = { customerId: cid, status: 2 };
            }
        }
        if (!st.tasks) st.tasks = {};
        // Bug 10.6 Fix: Ensure all 41 GuideBook tasks exist & are claimable
        for (var gTid = 2300001; gTid <= 2300041; gTid++) {
            if (!st.tasks[gTid]) {
                st.tasks[gTid] = {
                    taskId: gTid,
                    value: "1",
                    state: 0,
                    finishTime: 0,
                    taskStartTime: 0,
                    taskEndTime: 0
                };
            } else if (st.tasks[gTid].state === 0 && Number(st.tasks[gTid].value || 0) < 1) {
                st.tasks[gTid].value = "1";
            }
        }

        // Bug 3 & 6 Fix: Workshop maxWorkshopId = 500 + 10-step WorkshopConfigData
        if (!st.workshop) {
            st.workshop = {
                workshopId: isMax ? 10 : 1,
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
                maxWorkshopId: 500
            };
        }
        if (Number(st.workshop.maxWorkshopId || 0) < 500) {
            st.workshop.maxWorkshopId = 500;
        }
        if (!st.workshop.workshopConfig
            || Number(st.workshop.workshopConfig.id) !== Number(st.workshop.workshopId || 1)
            || Number(st.workshop.workshopConfig.num || 1) <= 1) {
            st.workshop.workshopConfig = buildWorkshopConfig(st.workshop.workshopId || 1);
        }

        // Ensure Houses, FishStore, DanceHall, VideoHall, Promote, Train, TvStudio, Happy52, BizWar, Lottery, NewbieTarget, Privileges exist
        if (!st.houses || st.houses.length === 0) st.houses = createDefaultHouses(isMax);
        if (!st.fishStore) st.fishStore = createDefaultFishStore(isMax);
        if (!st.danceHall) st.danceHall = createDefaultDanceHall(isMax);
        if (!st.videoHall) st.videoHall = createDefaultVideoHall(isMax);
        if (!st.promote) st.promote = createDefaultPromote(isMax);
        if (!st.train) st.train = createDefaultTrain(isMax);
        if (!st.tvStudio) st.tvStudio = createDefaultTvStudios(st);
        if (!st.happy52) st.happy52 = { myRank: isMax ? 5 : 50, myMaxRank: isMax ? 5 : 50, remainDailyChallengeCount: 20, dailyReward: 0, claimedRanks: [] };
        if (!st.bizWar) st.bizWar = { level: isMax ? 10 : 1, bussLevel: isMax ? 10 : 1, score: isMax ? 5000 : 100, bussWarMoney: isMax ? 50000 : 500, frequency: 20, lastGetRewardTime: 0, activeBattle: null };
        if (!st.lottery) st.lottery = { luckyValue: 0, records: [] };
        if (!st.newbieTarget) st.newbieTarget = { stageId: 1, startAt: Math.floor(now / 1000), submit: false, historyIncome: String(st.silver || "500000") };
        if (!st.privileges) buildPrivilegeList(st);

        // Always keep infinite Thẻ Giảm Giá / Vouchers topped up!
        ensureInfiniteVouchers(st);

        // Populate full DB items/heroes/beauties/cars/skins/decorations once DBMgr is ready on Server 1
        if (isMax && (!st.maxTesterApplied || (getDBTable("HeroDB") && !st.maxTesterDbPopulated))) {
            populateMaxTesterState(st);
        }

        if (st.buildings && st.buildings[15101]) {
            if (st.completeTaskIds.indexOf(2201101) < 0) st.completeTaskIds.push(2201101);
            ensureBusinessInBuilding(st.buildings[15101], 10101);
        }
        return st;
    }

    function getState(openId, serverId) {
        openId = openId || currentOpenId || "tiemtaphoa01";
        serverId = Number(serverId || currentServerId || 1);
        currentOpenId = openId;
        currentServerId = serverId;
        var cacheKey = openId + "_s" + serverId;
        if (!stateCache[cacheKey]) {
            var saved = loadJSON(SAVE_KEY_PREFIX + cacheKey, null);
            if (saved && saved.userId) {
                var def = createInitialState(openId, serverId);
                for (var k in def) {
                    if (saved[k] === undefined) saved[k] = def[k];
                }
                saved.serverId = serverId;
                stateCache[cacheKey] = migrateState(saved);
            } else {
                stateCache[cacheKey] = migrateState(createInitialState(openId, serverId));
            }
        }
        return stateCache[cacheKey];
    }

    function saveState(st) {
        if (!st) return;
        var cacheKey = (st.openId || currentOpenId || "tiemtaphoa01") + "_s" + Number(st.serverId || currentServerId || 1);
        saveJSON(SAVE_KEY_PREFIX + cacheKey, st);
    }

    function recalcEarnSpeed(st) {
        var dbUtil = getDBUtil();
        var totalAbility = 0;
        for (var hid in st.heroes) {
            if (!st.heroes.hasOwnProperty(hid)) continue;
            var h = st.heroes[hid];
            var base = 1000 + h.level * 350 + h.stageLv * 1200 + h.breakLv * 2500 + (h.awakenLevel || 0) * 3000;
            h.sumAbility = String(base + Number(h.addAbility || 0));
            totalAbility += Number(h.sumAbility);
        }
        var bEarn = 0;
        for (var bid in st.buildings) {
            if (!st.buildings.hasOwnProperty(bid)) continue;
            var b = st.buildings[bid];
            var basePerLv = 25;
            if (dbUtil && dbUtil.getMainBuilding) {
                try {
                    var cfg = dbUtil.getMainBuilding(Number(bid));
                    if (cfg && cfg.storeLevelUpEarning) basePerLv = Number(cfg.storeLevelUpEarning);
                } catch (e) {}
            }
            var mult = 1 + (b.expendlevel || 0) * 0.5 + (b.businessList ? b.businessList.length * 0.15 : 0) + (b.heroIdList ? b.heroIdList.length * 0.35 : 0);
            bEarn += Math.ceil((basePerLv * b.level + totalAbility / 500) * mult);
        }
        bEarn += Math.floor(totalAbility / 200);
        if (bEarn < 100) bEarn = 100;
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

    // Bug 8 & 12.3 Fix: Smart grantItem unlocks Heroes, Beauties, Cars, Skins, Decorations directly!
    function grantItem(st, itemId, count, delta) {
        itemId = Number(itemId);
        count = Number(count);
        if (!itemId || !count || count <= 0) return;
        var now = Date.now();
        if (itemId === 101000) {
            st.silver = addBigNumStr(st.silver, count);
            return;
        }
        if (itemId === 101001) {
            st.ingots = Number(st.ingots || 0) + count;
            return;
        }
        if (itemId === 101002) {
            st.prestige = addBigNumStr(st.prestige, count);
            return;
        }
        if (itemId === 101003) {
            st.patronsExp = addBigNumStr(st.patronsExp, count);
            return;
        }
        if (itemId === GAME_TIMECOIN_ID) {
            st.bag[itemId] = Math.max(999999999, Number(st.bag[itemId] || 0) + count);
            return;
        }
        // Hero unlock (HeroDB or 102000..102999)
        if (getDBRow("HeroDB", itemId) || (itemId >= 102000 && itemId < 103000)) {
            if (!st.heroes[itemId]) {
                st.heroes[itemId] = createHeroObj(itemId, 1, 1, 0, 0, now);
            } else {
                st.heroes[itemId].addAbility = addBigNumStr(st.heroes[itemId].addAbility, 500 * count);
            }
            recalcEarnSpeed(st);
            if (delta) { delta.heroes = delta.heroes || []; delta.heroes.push(st.heroes[itemId]); }
            return;
        }
        // Beauty unlock (BeautyDB or 103000..103999)
        if (getDBRow("BeautyDB", itemId) || (itemId >= 103000 && itemId < 104000)) {
            if (!st.beauties[itemId]) {
                st.beauties[itemId] = createBeautyObj(itemId, 1, 100, 100, now);
            } else {
                st.beauties[itemId].affinity = Number(st.beauties[itemId].affinity || 0) + 50 * count;
                st.beauties[itemId].influence = Number(st.beauties[itemId].influence || 0) + 50 * count;
            }
            recalcEarnSpeed(st);
            if (delta) { delta.beauties = delta.beauties || []; delta.beauties.push(st.beauties[itemId]); }
            return;
        }
        // Car unlock (CarDB or 104000..104999)
        if (getDBRow("CarDB", itemId) || (itemId >= 104000 && itemId < 105000)) {
            var n = Math.min(count, 5);
            for (var ci = 0; ci < n; ci++) {
                var newCid = nextCarUid(st);
                var newCar = createCarObj(newCid, itemId, 1, 0, 0, Object.keys(st.cars || {}).length === 0);
                st.cars[newCid] = newCar;
                if (st.carTemplates.indexOf(itemId) < 0) st.carTemplates.push(itemId);
                if (delta) { delta.cars = delta.cars || []; delta.cars.push(newCar); }
            }
            return;
        }
        // Decoration unlock (LeadDecorateDB or 106000..106999)
        if (getDBRow("LeadDecorateDB", itemId) || (itemId >= 106000 && itemId < 107000)) {
            st.decorations = st.decorations || {};
            st.decorations[itemId] = { decorationId: itemId, endTime: 0, modifyTime: Math.floor(now / 1000), status: 1 };
            if (delta) { delta.decorations = true; }
            return;
        }
        // Skin unlock (SkinDB or 109000..109999)
        var skinRow = getDBRow("SkinDB", itemId);
        if (skinRow || (itemId >= 109000 && itemId < 110000)) {
            st.skins = st.skins || {};
            st.playerSkins = st.playerSkins || [];
            var roleId = skinRow ? Number(skinRow.belongRole || skinRow.roleId || skinRow.ownerId || 0) : 0;
            var sType = skinRow ? Number(skinRow.type || 0) : 3;
            if (sType === 3 || sType === 4 || roleId === 0 || roleId < 1000) {
                if (st.playerSkins.indexOf(itemId) < 0) st.playerSkins.push(itemId);
            } else {
                if (!st.skins[roleId]) st.skins[roleId] = { dressingSkinId: 0, skinIds: [] };
                if (st.skins[roleId].skinIds.indexOf(itemId) < 0) st.skins[roleId].skinIds.push(itemId);
            }
            if (delta) { delta.skins = true; }
            return;
        }
        // Regular bag item
        st.bag[itemId] = Number(st.bag[itemId] || 0) + count;
    }

    function grantRewardString(st, rewardStr, delta) {
        var items = parseRewardString(rewardStr);
        for (var i = 0; i < items.length; i++) {
            grantItem(st, items[i].id, items[i].count, delta);
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
            case 1: val = Math.max(1, st.loginTotalDays || 1); break;
            case 3: val = st.buildings[p2] ? Number(st.buildings[p2].level || 1) : 0; break;
            case 18: val = Number(st.heroSkillUpgradeCount || 0); break;
            case 104: val = st.buildings[p2] ? 1 : 0; break;
            case 105: {
                var dispCnt = 0;
                for (var dbKey in st.buildings) {
                    if (!st.buildings.hasOwnProperty(dbKey)) continue;
                    var hl = st.buildings[dbKey].heroIdList || [];
                    dispCnt += hl.length;
                }
                val = dispCnt;
                break;
            }
            case 106: {
                var hCnt = 0;
                for (var hKey in st.heroes) {
                    if (!st.heroes.hasOwnProperty(hKey)) continue;
                    if (Number(st.heroes[hKey].level || 1) >= p2) hCnt++;
                }
                val = hCnt;
                break;
            }
            case 109: val = st.titleId || 1; break;
            case 154: {
                var ws = st.workshop || { workshopId: 1, sectionProgress: 1 };
                if (Number(ws.workshopId || 1) > p2) val = target;
                else if (Number(ws.workshopId || 1) === p2) val = Number(ws.sectionProgress || 1);
                else val = 0;
                break;
            }
            case 157: val = (st.buildingServeCounts && st.buildingServeCounts[p2]) ? Number(st.buildingServeCounts[p2]) : 0; break;
            case 170: {
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
            var serverMax = {
                serverId: 1,
                name: encodeURIComponent("S1 - Max Tester Lv60 (VIP15 Full)"),
                url: "http://127.0.0.1:8080",
                openTime: 1700000000000,
                status: 1,
                state: 1,
                allowLogin: true,
                isNew: true,
                markStr: ""
            };
            var serverNewbie = {
                serverId: 2,
                name: encodeURIComponent("S2 - Góc Chợ Xưa Offline (Tân Thủ)"),
                url: "http://127.0.0.1:8080",
                openTime: 1700000000000,
                status: 1,
                state: 1,
                allowLogin: true,
                isNew: false,
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
                serverList: JSON.stringify([serverMax, serverNewbie]),
                userServerList: [1, 2],
                recommendServer: serverMax,
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
            var stCreate = getState(currentOpenId, currentServerId);
            stCreate.hasRole = true;
            if (params.nickName) stCreate.nickName = String(params.nickName);
            if (!stCreate.nickName) stCreate.nickName = pickRandomName(params.sex || 2);
            if (params.sex) stCreate.sex = Number(params.sex);
            if (params.player) stCreate.player = Number(params.player);
            var roleDef = PLAYER_ROLE_DEFAULTS[stCreate.player] || PLAYER_ROLE_DEFAULTS[1];
            stCreate.headId = (params.headId && Number(params.headId) >= 106000) ? Number(params.headId) : roleDef.headId;
            stCreate.costumeId = (params.costumeId && Number(params.costumeId) >= 106000) ? Number(params.costumeId) : roleDef.costumeId;
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
            var reqSrv = Number(params.serverId || 0);
            if (!reqSrv) {
                var savedPI = loadJSON("PLAYER_INFO", null);
                reqSrv = (savedPI && Number(savedPI.serverId)) ? Number(savedPI.serverId) : currentServerId;
            }
            if (reqSrv !== 1 && reqSrv !== 2) reqSrv = 1;
            var st = getState(openId, reqSrv);
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

        // Recharge order creation & fulfillment (supports Voucher & SimulateRecharge!)
        if (u.indexOf("recharge_order") >= 0 || u.indexOf("_order") >= 0) {
            var orderId = "offline_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
            var prodId = Number(params.productId || params.product_id || 0);
            pendingRechargeOrders[orderId] = {
                productId: prodId,
                voucherItemId: Number(params.voucherItemId || 0),
                dext: String(params.dext || "")
            };
            return {
                result: 0,
                code: 0,
                orderId: orderId,
                data: { orderId: orderId },
                message: "ok",
                msg: "ok"
            };
        }

        if (u.indexOf("/recharge") >= 0 || u.indexOf("recharge") >= 0) {
            var oid = String(params.orderId || "");
            var ord = pendingRechargeOrders[oid];
            if (ord && ord.productId > 0) {
                delete pendingRechargeOrders[oid];
                var stRech = getState(currentOpenId, currentServerId);
                deliverShopPurchase(stRech, ord.productId, 1, activeWs, oid, ord.dext, false);
            }
            return { result: 0, code: 0, data: { ok: true }, message: "ok", msg: "ok" };
        }

        if (u.indexOf(".manifest") >= 0) {
            return "{}";
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
            if (typeof Promise === "function") {
                Promise.resolve().then(deliver);
            } else {
                setTimeout(deliver, 0);
            }
        } else {
            deliver();
        }
    };

    global.XMLHttpRequest = OfflineXMLHttpRequest;

    // =========================================================================
    // 8. WebSocket Gameplay Server & Handlers
    // =========================================================================
    function buildPlayerDataMsg(st) {
        var decoObj = {
            1: (st.headId && st.headId >= 106000) ? st.headId : DEFAULT_HEAD_ID,
            3: (st.costumeId && st.costumeId >= 106000) ? st.costumeId : DEFAULT_COSTUME_ID
        };
        if (st.frameId && st.frameId >= 106000) decoObj[2] = st.frameId;
        if (st.titleDecoId && st.titleDecoId >= 106000) decoObj[4] = st.titleDecoId;
        if (st.bubbleId && st.bubbleId >= 106000) decoObj[5] = st.bubbleId;
        var decoration = JSON.stringify(decoObj);
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
                sex: st.sex || 2,
                earnSpeed: String(st.earnSpeed || "100"),
                registerTime: st.registerTime || Date.now(),
                serverId: st.serverId || 1,
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
            rechargeToken: Number(st.rechargeToken || 999999999)
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

    function buildRechargeGainList(st) {
        var list = [];
        st.rechargeGained = st.rechargeGained || {};
        for (var mid in st.rechargeGained) {
            if (st.rechargeGained.hasOwnProperty(mid)) {
                list.push({ mallId: Number(mid), state: Number(st.rechargeGained[mid] || 1) });
            }
        }
        return list;
    }

    // Unified Shop / Voucher / Paid Pack Fulfillment (used by 24104, /recharge, and 24102)
    function deliverShopPurchase(st, shopGoodsId, count, ws, orderId, dext, isItemBuy) {
        shopGoodsId = Number(shopGoodsId || 0);
        count = Math.max(1, Number(count || 1));
        var dbUtil = getDBUtil();
        var shopCfg = null;
        if (dbUtil && typeof dbUtil.getShop === "function") {
            try { shopCfg = dbUtil.getShop(shopGoodsId); } catch (e) {}
        }
        if (!shopCfg) shopCfg = getDBRow("ShopDB", shopGoodsId);

        var rewardStr = "";
        if (shopCfg && shopCfg.reward && shopCfg.reward !== "0") {
            rewardStr = multiplyRewardString(shopCfg.reward, count);
        } else {
            rewardStr = "101001=" + (600 * count);
        }

        var delta = {};
        grantRewardString(st, rewardStr, delta);

        // Add VIP exp & activate privilege cards for paid packs
        var priceVal = shopCfg ? Number(shopCfg.price || 0) : 0;
        if (priceVal > 0 && isNaN(Number(shopCfg.price)) === false) {
            st.vipExp = Number(st.vipExp || 0) + Math.max(100, Math.floor(priceVal / 10));
        }
        var now = Date.now();
        var isRepeat = !!(st.rechargeGained && st.rechargeGained[shopGoodsId]);
        st.rechargeGained = st.rechargeGained || {};
        st.rechargeGained[shopGoodsId] = 1;
        st.shopBought = st.shopBought || {};
        st.shopBought[shopGoodsId] = Number(st.shopBought[shopGoodsId] || 0) + count;

        // If purchasing privilege/monthly/annual card, activate all privileges
        if (shopGoodsId >= 20000000 && shopGoodsId <= 20000100) {
            buildPrivilegeList(st);
            for (var pk in st.privileges) {
                if (st.privileges.hasOwnProperty(pk)) {
                    st.privileges[pk].canGetReward = true;
                    st.privileges[pk].endTime = now + 3650 * 86400000;
                }
            }
        }

        ensureInfiniteVouchers(st);
        recalcEarnSpeed(st);
        saveState(st);

        if (ws && !ws._closed && ws.readyState === 1) {
            ws._pushDelta(st, delta);
            ws._push(206, st.userId, {
                productId: shopGoodsId,
                isRepeatBuy: isRepeat,
                orderId: orderId || ("offline_v_" + now),
                itemBuy: !!isItemBuy,
                dext: dext || "",
                firstRecharge: !isRepeat
            });
            ws._push(203, st.userId, { dataList: buildRechargeGainList(st) });
            ws._push(5201, st.userId, { privilegedList: buildPrivilegeList(st) });
            ws._push(104, st.userId, buildPlayerDataMsg(st));
            ws._pushAttrs(st);
            ws._pushBag(st);
            ws._pushEarnSpeed(st);
        }
        return rewardStr;
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
        var openFn = function () {
            if (self._closed) return;
            self.readyState = 1; // OPEN
            activeWs = self;
            if (typeof self.onopen === "function") {
                self.onopen({ type: "open" });
            }
        };
        if (typeof Promise === "function") {
            Promise.resolve().then(openFn);
        } else {
            setTimeout(openFn, 10);
        }
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
            var deliverMsg = function () {
                if (self._closed || self.readyState !== 1) return;
                if (typeof self.onmessage === "function") {
                    self.onmessage({ data: buf });
                }
            };
            if (typeof Promise === "function") {
                Promise.resolve().then(deliverMsg);
            } else {
                setTimeout(deliverMsg, 0);
            }
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

    OfflineWebSocket.prototype._pushHeroAbilities = function (st) {
        this._push(510, st.userId, { heroAbilityList: buildHeroAbilityList(st) });
    };

    OfflineWebSocket.prototype._pushBag = function (st) {
        ensureInfiniteVouchers(st);
        this._push(601, st.userId, { itemList: buildBagList(st) });
    };

    OfflineWebSocket.prototype._pushDelta = function (st, delta) {
        if (!delta) return;
        if (delta.heroes && delta.heroes.length > 0) {
            this._push(502, st.userId, { patronsList: delta.heroes });
            this._pushHeroAbilities(st);
        }
        if (delta.beauties && delta.beauties.length > 0) {
            this._push(4302, st.userId, { beautyList: delta.beauties });
        }
        if (delta.cars && delta.cars.length > 0) {
            this._push(4202, st.userId, { carList: delta.cars });
            this._push(4203, st.userId, { templateIdList: st.carTemplates || [], gainedTemplateId: st.carTemplates || [], skin: [] });
        }
        if (delta.decorations) {
            this._push(802, st.userId, { decorationList: buildDecorationList(st) });
        }
        if (delta.skins) {
            this._push(7024, st.userId, buildSkinInfoMsg(st));
        }
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
        if (activeWs === this) activeWs = null;
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
        var st = getState(currentOpenId, currentServerId);
        var uid = pkt.userId || st.userId;
        var recvId = toRecvProtocol(cmdId);

        if (cmdId !== 20102) {
            log("C2S cmdId=" + cmdId + " -> recvId=" + recvId);
        }

        try {
            this._handleCommand(cmdId, recvId, uid, req, st);
        } catch (e) {
            warn("Command handler error cmdId=" + cmdId, e && (e.stack || e.message));
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
                    st = getState(req.openId, currentServerId);
                    uid = st.userId;
                }
                activeWs = this;
                migrateState(st);
                syncAllBusinessTasks(st);
                tickPassiveIncome(st);
                recalcEarnSpeed(st);
                st.lastLoginTime = now;
                evaluateTaskProgress(st, st.mainTaskId || 200001);
                updateAllActiveTasks(st);
                saveState(st);

                installRuntimePatches();
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
                // 9. Buildings (401)
                this._push(401, uid, { buildingList: objValues(st.buildings) });
                // 10. Heroes / Patrons (501) + Hero Abilities (510 - Bug 4 & 8 fix!)
                this._push(501, uid, { patronsList: objValues(st.heroes) });
                this._pushHeroAbilities(st);
                // 11. Beauties (4301) & Energy (4307)
                this._push(4301, uid, { beautyList: objValues(st.beauties) });
                this._push(4307, uid, { energy: Number(st.beautyEnergy || 10), lastRestoreTime: st.beautyEnergyTime || now });
                // 12. Cars (4201 & 4203 - Bug 10.1 fix!)
                this._push(4201, uid, { carList: objValues(st.cars) });
                this._push(4203, uid, {
                    templateIdList: st.carTemplates || [104001],
                    gainedTemplateId: st.carTemplates || [104001],
                    skin: []
                });
                // 13. Customers (4601)
                this._push(4601, uid, { customerList: buildCustomerList(st) });
                // 14. Bag (601 - includes infinite Thẻ Giảm Giá 101011 & Vouchers!)
                this._pushBag(st);
                // 15. Decorations (801 - Bug 7.2 Avatar fix!) & Skins (7024 & 7026 - Bug 7.3 fix!)
                this._push(801, uid, { decorationList: buildDecorationList(st) });
                var skinMsg = buildSkinInfoMsg(st);
                this._push(7024, uid, skinMsg);
                this._push(7026, uid, { foreverPlayerSkinInfos: skinMsg.foreverPlayerSkinInfos });
                // 16. Tasks (1201, 1203, 1204, 1209)
                this._push(1201, uid, { dataList: objValues(st.tasks) });
                this._push(1203, uid, { taskActive: st.taskActive || 0, rewardIndexList: st.taskActiveRewards || [] });
                this._push(1204, uid, { taskActive: st.sevenDayActive || 0, rewardIndexList: st.sevenDayRewards || [], sevenDayStartTime: st.registerTime });
                this._push(1209, uid, { taskId: st.completeTaskIds || [], all: true });
                // 17. Mail (301)
                this._push(301, uid, { mailList: st.mails || [] });
                // 18. Sign-in (4851)
                this._push(4851, uid, {
                    currentSignDays: st.sign.currentSignDays || 0,
                    lastSignDays: st.sign.lastSignDays || 0,
                    totalSignDays: st.sign.totalSignDays || 0,
                    gainedAccumulateIndex: st.sign.gainedAccumulateIndex || [],
                    cycleCount: st.sign.cycleCount || 1,
                    today: { items: [], lucks: [] },
                    yesterday: { items: [], lucks: [] }
                });
                // 19. Workshop (5601), Privileges (5201), VIP (5901), Recharge (203), Lottery (2005),
                //     House (4002), FishStore (7100), BizWar (4902 & 4920), NewbieTarget (1001053)
                if (st.workshop) {
                    this._push(5601, uid, { workshopData: st.workshop });
                }
                this._push(5201, uid, { privilegedList: buildPrivilegeList(st) });
                this._push(5901, uid, { rewardedLevel: st.vipRewardedLevels || [] });
                this._push(203, uid, { dataList: buildRechargeGainList(st) });
                this._push(2005, uid, { dataList: (st.lottery && st.lottery.records) ? st.lottery.records : [] });
                this._push(4002, uid, {
                    houseList: st.houses || createDefaultHouses(st.serverId === 1),
                    houseComfortLevel: Number(st.houseComfortLevel || 1),
                    houseComfortValue: Number(st.houseComfortValue || 100)
                });
                if (st.fishStore) {
                    this._push(7100, uid, st.fishStore);
                }
                this._push(4902, uid, {
                    level: Number(st.bizWar ? st.bizWar.level : 1),
                    score: Number(st.bizWar ? st.bizWar.score : 100),
                    bussWarMoney: Number(st.bizWar ? st.bizWar.bussWarMoney : 500),
                    frequency: Number(st.bizWar ? st.bizWar.frequency : 20)
                });
                var bwHeroes = [];
                for (var bwh in st.heroes) {
                    if (st.heroes.hasOwnProperty(bwh)) {
                        bwHeroes.push({
                            heroId: Number(bwh),
                            battleTimes: 5,
                            buyBattleTimes: 0,
                            randomBattleTimes: 5,
                            randomBattleRestoreTimes: 0,
                            restoreRandomBattleTime: 0,
                            specialBattleTime: 0,
                            recoverSpecialTime: 0,
                            recoverSpecialRound: 0
                        });
                    }
                }
                this._push(4920, uid, { heroDataList: bwHeroes });
                this._push(1001053, uid, { newbie: st.newbieTarget });
                this._push(1000302, uid, { heroList: [], beautyList: [], typeList: [] });
                this._push(1000303, uid, { configs: [] });
                // 20. Finally smInitDataEnd (103)
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

            // ---------------- PLAYER PROFILE, IDENTITY, CHANGE PLAYER, DECORATION (Bug 1 & 7) ----------------
            case 20108: { // S_TITLE_UPGRADE
                var nextTitle = Number(st.titleId || 1) + 1;
                var idCfg = null;
                var dbUI = getDBUtil();
                if (dbUI && typeof dbUI.getIdentityByLevel === "function") {
                    try { idCfg = dbUI.getIdentityByLevel(nextTitle); } catch (e) {}
                }
                if (!idCfg) idCfg = getDBRow("IdentityDB", 10000 + nextTitle) || getDBRow("IdentityDB", nextTitle);
                st.titleId = nextTitle;
                var deltaT = {};
                if (idCfg && idCfg.addRewards && idCfg.addRewards !== "0") {
                    grantRewardString(st, idCfg.addRewards, deltaT);
                } else {
                    grantItem(st, 101001, 200);
                }
                st.openSystems = getAllSystemIds();
                saveState(st);
                this._push(108, uid, { ret: 0, titleId: st.titleId });
                this._push(104, uid, buildPlayerDataMsg(st));
                this._push(111, uid, { openSystems: st.openSystems });
                this._pushDelta(st, deltaT);
                this._pushAttrs(st);
                this._pushBag(st);
                this._pushTaskUpdates(st);
                return;
            }
            case 20109: { // S_TITLE_GET_REWARD
                var curIdCfg = getDBRow("IdentityDB", 10000 + Number(st.titleId || 1)) || getDBRow("IdentityDB", st.titleId || 1);
                var dailyIng = (curIdCfg && curIdCfg.dailyIngots) ? Number(curIdCfg.dailyIngots) : (100 + (st.titleId || 1) * 20);
                st.getTitleRewardTime = now;
                st.ingots = Number(st.ingots || 0) + dailyIng;
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
                this._push(116, uid, { name: pickRandomName(req.sex || 2) });
                return;
            }
            case 20157: { // S_CHANGE_SIGN
                st.playerSign = req.content || "";
                saveState(st);
                this._push(157, uid, { ret: 0 });
                this._push(104, uid, buildPlayerDataMsg(st));
                return;
            }
            case 20177: { // S_CHANGE_PLAYER (Bug 7.1 Fix!)
                var newPlayer = Number(req.player || 1);
                var rd = PLAYER_ROLE_DEFAULTS[newPlayer] || PLAYER_ROLE_DEFAULTS[1];
                st.player = newPlayer;
                st.sex = rd.sex;
                st.headId = rd.headId;
                st.costumeId = rd.costumeId;
                st.changePlayerCount = Number(st.changePlayerCount || 0) + 1;
                saveState(st);
                this._push(177, uid, { ret: 0, player: st.player });
                this._push(104, uid, buildPlayerDataMsg(st));
                return;
            }
            case 20190: { // S_CHANGE_SEX
                st.sex = Number(req.sex || 2);
                saveState(st);
                this._push(190, uid, { ret: 0 });
                this._push(104, uid, buildPlayerDataMsg(st));
                return;
            }
            case 20803: { // S_DECORATION_CHANGE (Bug 7.2 Avatar/Figure Change!)
                var dType = Number(req.decorationType || 1);
                var dId = Number(req.decorationId || 0);
                if (dType === 1 && dId >= 106000) st.headId = dId;
                else if (dType === 2) st.frameId = dId;
                else if (dType === 3 && dId >= 106000) st.costumeId = dId;
                else if (dType === 4) st.titleDecoId = dId;
                else if (dType === 5) st.bubbleId = dId;
                var pdm = buildPlayerDataMsg(st);
                saveState(st);
                this._push(803, uid, { ret: 0, decoration: pdm.playerBaseData.decoration });
                this._push(104, uid, pdm);
                return;
            }
            case 20804: { // S_DECORATION_STATUS
                var dsId = Number(req.decorationId || 0);
                if (st.decorations && st.decorations[dsId]) {
                    st.decorations[dsId].status = 1;
                }
                saveState(st);
                this._push(804, uid, { ret: 0, decorationId: dsId });
                return;
            }

            // ---------------- SKINS (Bug 7.3 Fix!) ----------------
            case 27024: { // S_SKIN_INFO
                this._push(7024, uid, buildSkinInfoMsg(st));
                return;
            }
            case 27021: { // S_SKIN_DRESS
                var skIdD = Number(req.skinId || 0);
                var skRoleId = Number(req.roleId || 0);
                var skTypeD = Number(req.type || 0);
                if (skRoleId > 0) {
                    st.skins = st.skins || {};
                    if (!st.skins[skRoleId]) st.skins[skRoleId] = { dressingSkinId: 0, skinIds: [] };
                    st.skins[skRoleId].dressingSkinId = skIdD;
                    if (skIdD > 0 && st.skins[skRoleId].skinIds.indexOf(skIdD) < 0) {
                        st.skins[skRoleId].skinIds.push(skIdD);
                    }
                    if (st.heroes[skRoleId]) {
                        st.heroes[skRoleId].skinId = skIdD;
                        this._push(502, uid, { patronsList: [st.heroes[skRoleId]] });
                    }
                    if (st.beauties[skRoleId]) {
                        st.beauties[skRoleId].skinId = skIdD;
                        this._push(4302, uid, { beautyList: [st.beauties[skRoleId]] });
                    }
                } else if (skTypeD === 3 && skIdD > 0) {
                    if (st.playerSkins.indexOf(skIdD) < 0) st.playerSkins.push(skIdD);
                }
                saveState(st);
                this._push(7021, uid, { ret: 0, skinId: skIdD, roleId: skRoleId });
                this._push(7024, uid, buildSkinInfoMsg(st));
                return;
            }
            case 27022: { // S_SKIN_SKILL_UPGRADE
                this._push(7022, uid, { ret: 0 });
                this._push(7024, uid, buildSkinInfoMsg(st));
                return;
            }

            // ---------------- GIFT / EXCHANGE CODES ----------------
            case 20135: { // S_USE_EXCHANGE_KEY
                var code = String(req.key || "").trim().toUpperCase();
                var rewardStr = "101000=1000000;101001=50000;101003=200000;101011=999999;110001=200";
                if (code === "MAX60" || code === "TESTER" || code === "FULL") {
                    populateMaxTesterState(st);
                    rewardStr = "101000=999999999;101001=9999999;101011=999999999";
                    this._push(104, uid, buildPlayerDataMsg(st));
                    this._push(111, uid, { openSystems: st.openSystems });
                    this._push(502, uid, { patronsList: objValues(st.heroes) });
                    this._pushHeroAbilities(st);
                    this._push(4302, uid, { beautyList: objValues(st.beauties) });
                    this._push(4202, uid, { carList: objValues(st.cars) });
                    this._push(4203, uid, { templateIdList: st.carTemplates || [], gainedTemplateId: st.carTemplates || [], skin: [] });
                    this._push(802, uid, { decorationList: buildDecorationList(st) });
                    this._push(7024, uid, buildSkinInfoMsg(st));
                } else if (code === "RICH" || code === "VIP999") {
                    rewardStr = "101000=999999999;101001=999999;101002=100000;101003=9999999;101011=9999999;110001=5000";
                    st.vipExp = Math.max(99999999, Number(st.vipExp || 0) + 100000);
                } else if (code === "ALLHERO") {
                    var allH = getDBTableIds("HeroDB");
                    if (allH.length === 0) allH = [102210, 102240, 102220, 102230, 102241, 102231];
                    for (var hi = 0; hi < allH.length; hi++) {
                        if (!st.heroes[allH[hi]]) st.heroes[allH[hi]] = createHeroObj(allH[hi], 60, 5, 5, 5, now);
                    }
                    var allB = getDBTableIds("BeautyDB");
                    if (allB.length === 0) allB = [103201, 103202, 103203, 103204, 103205];
                    for (var bi = 0; bi < allB.length; bi++) {
                        if (!st.beauties[allB[bi]]) st.beauties[allB[bi]] = createBeautyObj(allB[bi], 60, 5000, 5000, now);
                    }
                    this._push(502, uid, { patronsList: objValues(st.heroes) });
                    this._pushHeroAbilities(st);
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
                if (bSyncOpen.newlyCompletedIds.length > 0) this._push(1209, uid, { taskId: bSyncOpen.newlyCompletedIds, all: false });
                if (bSyncOpen.changedTasks.length > 0) this._push(1202, uid, { dataList: bSyncOpen.changedTasks });
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
                    if (bSyncUp.newlyCompletedIds.length > 0) this._push(1209, uid, { taskId: bSyncUp.newlyCompletedIds, all: false });
                    if (bSyncUp.changedTasks.length > 0) this._push(1202, uid, { dataList: bSyncUp.changedTasks });
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
                var inc = Math.max(50, Number(st.earnSpeed || 100) * 3);
                st.silver = addBigNumStr(st.silver, inc);
                saveState(st);
                this._push(420, uid, { ret: 0, income: inc, offlineIncome: 0, canGetGameCoin: 0, ticket: 0 });
                this._pushAttrs(st);
                return;
            }
            case 20423: { // S_BUILDING_GET_INCOME
                var gInc = Math.max(100, Number(st.earnSpeed || 100) * 5);
                st.silver = addBigNumStr(st.silver, gInc);
                saveState(st);
                this._push(423, uid, { ret: 0 });
                this._pushAttrs(st);
                return;
            }
            case 20424: { // S_BUILDING_HANDLE
                var hbid = Number(req.buildingId || 15101);
                var hItemId = Number(req.itemId || 10101);
                var hInc = Math.max(50, Number(st.earnSpeed || 100) * 2);
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
                    if (detMap.hasOwnProperty(ik)) detList.push({ itemId: Number(ik), num: Number(detMap[ik]) });
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

            // ---------------- WORKSHOP / ẢI (Bug 3 & 6 Fix!) ----------------
            case 25611: { // S_WORKSHOP_INFO
                migrateState(st);
                this._push(5611, uid, { ret: 0, workshopData: st.workshop });
                this._push(5601, uid, { workshopData: st.workshop });
                return;
            }
            case 25617: { // S_WORKSHOP_CONFIG
                var reqIds = Array.isArray(req.workshopConfigIds) ? req.workshopConfigIds : [st.workshop ? st.workshop.workshopId : 1];
                var cfgs = [];
                for (var wi = 0; wi < reqIds.length; wi++) {
                    cfgs.push(buildWorkshopConfig(reqIds[wi]));
                }
                this._push(5617, uid, { ret: 0, workshopConfigs: cfgs });
                return;
            }
            case 25618: { // S_WORKSHOP_GET_STANDARD_CONFIG_DATA
                var reqStdIds = Array.isArray(req.workshopConfigIds) ? req.workshopConfigIds : [st.workshop ? st.workshop.workshopId : 1];
                var stdCfgs = [];
                for (var swi = 0; swi < reqStdIds.length; swi++) {
                    stdCfgs.push(buildWorkshopStandardConfig(reqStdIds[swi]));
                }
                this._push(5618, uid, { ret: 0, workshopStandardConfigs: stdCfgs });
                return;
            }
            case 25602: { // S_WORKSHOP_UPGRADE
                migrateState(st);
                var ws = st.workshop;
                var maxSteps = (ws.workshopConfig && Number(ws.workshopConfig.num)) ? Number(ws.workshopConfig.num) : 10;
                ws.sectionProgress = Number(ws.sectionProgress || 1) + 1;
                if (ws.sectionProgress >= maxSteps) {
                    ws.sectionProgress = maxSteps;
                    ws.isBoss = 1;
                }
                var wsExp = 200 * Number(ws.workshopId || 1);
                var wsPrestige = 20 * Number(ws.workshopId || 1);
                var wsRew = "101000=" + (1500 * Number(ws.workshopId || 1)) + ";101002=" + wsPrestige;
                grantRewardString(st, wsRew);
                grantItem(st, 101003, wsExp);
                saveState(st);
                this._push(5602, uid, {
                    ret: 0,
                    workshopData: ws,
                    reward: wsRew,
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
            case 25605: { // S_WORKSHOP_ONE_KEY_DEAL
                migrateState(st);
                st.workshop.events = [];
                var evRew = "101000=5000;101002=50";
                grantRewardString(st, evRew);
                saveState(st);
                this._push(recvId, uid, { ret: 0, reward: evRew });
                this._push(5601, uid, { workshopData: st.workshop });
                this._pushAttrs(st);
                return;
            }
            case 25606: { // S_WORKSHOP_BOSS_BATTLE (advance stage!)
                migrateState(st);
                var bws = st.workshop;
                var completedWid = Number(bws.workshopId || 1);
                var bossRew = (bws.workshopConfig && bws.workshopConfig.completeReward)
                    ? bws.workshopConfig.completeReward
                    : ("101000=" + (3000 * completedWid) + ";101002=" + (30 * completedWid));
                var bossExp = (bws.workshopConfig && bws.workshopConfig.bossExpReward) ? Number(bws.workshopConfig.bossExpReward) : 500 * completedWid;
                var bossPres = (bws.workshopConfig && bws.workshopConfig.bossPrestige) ? Number(bws.workshopConfig.bossPrestige) : 30 * completedWid;
                bws.workshopId = completedWid + 1;
                bws.maxWorkshopId = Math.max(500, bws.workshopId);
                bws.sectionProgress = 1;
                bws.isBoss = 0;
                bws.events = [];
                bws.workshopConfig = buildWorkshopConfig(bws.workshopId);
                grantRewardString(st, bossRew);
                grantItem(st, 101003, bossExp);
                var totalAb = 0;
                for (var ah in st.heroes) { if (st.heroes.hasOwnProperty(ah)) totalAb += Number(st.heroes[ah].sumAbility || 1000); }
                saveState(st);
                this._push(5606, uid, {
                    ret: 0,
                    heroTotalAbility: Math.max(10000, totalAb),
                    workshopData: bws,
                    reward: bossRew,
                    experience: bossExp,
                    prestige: bossPres
                });
                this._push(5601, uid, { workshopData: bws });
                this._pushAttrs(st);
                this._pushTaskUpdates(st);
                return;
            }
            case 25607: { // S_WORKSHOP_ONHOOK_INFO
                this._push(5607, uid, { onhookTime: 3600, totalExp: 50000, curAddExp: 500 });
                return;
            }
            case 25608: { // S_WORKSHOP_ONHOOK_REWARD
                grantItem(st, 101003, 50000);
                grantItem(st, 101000, 50000);
                saveState(st);
                this._push(5608, uid, { ret: 0 });
                this._pushAttrs(st);
                return;
            }
            case 25609: { // S_WORKSHOP_SCENE_EVENT
                var seRew = "101000=3000;101002=15";
                grantRewardString(st, seRew);
                saveState(st);
                this._push(5609, uid, { ret: 0, reward: seRew, sceneEvent: [] });
                this._pushAttrs(st);
                return;
            }
            case 25610: { // S_WORKSHOP_URGE
                st.workshop.urgeCount = Number(st.workshop.urgeCount || 0) + 1;
                st.workshop.urgeTime = Math.floor(now / 1000);
                saveState(st);
                this._push(5610, uid, { ret: 0, time: st.workshop.urgeTime, buffAddEarn: 500 });
                return;
            }

            // ---------------- HEROES / PATRONS (Bug 4 & 8 Fix!) ----------------
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
                    this._pushHeroAbilities(st);
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
                    this._pushHeroAbilities(st);
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
                    this._pushHeroAbilities(st);
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
                    this._pushHeroAbilities(st);
                    this._pushEarnSpeed(st);
                    this._pushTaskUpdates(st);
                } else {
                    this._push(505, uid, { ret: 0, patronsId: skHid, skillId: skId, skillLv: newLv, type: skType });
                }
                return;
            }
            case 20506: { // S_HERO_EQUIP_CAR (Bug 4 Fix: equip & unequip cleanly!)
                var eqHeroId = Number(req.heroId || 0);
                var eqCarIdStr = String(req.carId || "");
                var eqHero = st.heroes[eqHeroId];
                var changedHeroes = [];
                var changedCars = [];
                // Unequip any existing car currently worn by this hero
                for (var oldCk in st.cars) {
                    if (st.cars.hasOwnProperty(oldCk) && Number(st.cars[oldCk].heroId) === eqHeroId) {
                        st.cars[oldCk].heroId = 0;
                        changedCars.push(st.cars[oldCk]);
                    }
                }
                if (eqHero) {
                    eqHero.carId = 0;
                    if (eqCarIdStr && st.cars[eqCarIdStr]) {
                        var eqCar = st.cars[eqCarIdStr];
                        // If car was worn by another hero, detach from that hero
                        if (eqCar.heroId && st.heroes[eqCar.heroId] && Number(eqCar.heroId) !== eqHeroId) {
                            st.heroes[eqCar.heroId].carId = 0;
                            changedHeroes.push(st.heroes[eqCar.heroId]);
                        }
                        eqCar.heroId = eqHeroId;
                        eqHero.carId = Number(eqCar.templateId || 0);
                        if (changedCars.indexOf(eqCar) < 0) changedCars.push(eqCar);
                    }
                    if (changedHeroes.indexOf(eqHero) < 0) changedHeroes.push(eqHero);
                }
                recalcEarnSpeed(st);
                saveState(st);
                this._push(506, uid, { ret: 0 });
                if (changedHeroes.length > 0) this._push(502, uid, { patronsList: changedHeroes });
                if (changedCars.length > 0) this._push(4202, uid, { carList: changedCars });
                this._pushHeroAbilities(st);
                this._pushEarnSpeed(st);
                return;
            }

            // ---------------- BEAUTIES & ARTISTS PROPAGATE (Bug 5.4 Fix!) ----------------
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
                    this._pushHeroAbilities(st);
                    this._pushEarnSpeed(st);
                } else {
                    this._push(4303, uid, { ret: 0 });
                }
                return;
            }
            case 24308: { // S_BEAUTY_PROPAGATE (Exact proto fields + real energy deduct + real rewards!)
                var propType = Number(req.type || 1);
                var bList = objValues(st.beauties);
                var curEnergy = Math.max(0, Number(st.beautyEnergy || 0));
                if (curEnergy <= 0) {
                    // Auto-recover if empty on Max Tester, else inform user via energy=0
                    if (st.serverId === 1) curEnergy = 10;
                }
                var runs = propType === 2 ? Math.max(1, curEnergy) : (curEnergy > 0 ? 1 : 0);
                var propList = [];
                var updatedBeauties = [];
                var totalSilverGain = 0;
                for (var pr = 0; pr < runs; pr++) {
                    if (bList.length === 0) break;
                    var targetB = bList[Math.floor(Math.random() * bList.length)];
                    var isCrit = (Math.random() < 0.25);
                    var addExp = (50 + Number(targetB.level || 1) * 10) * (isCrit ? 2 : 1);
                    var addMoney = Math.max(5000, Number(st.earnSpeed || 500) * 5) * (isCrit ? 2 : 1);
                    targetB.affinity = Number(targetB.affinity || 0) + addExp;
                    targetB.influence = Number(targetB.influence || 0) + Math.floor(addExp / 2);
                    targetB.fetterVal = Number(targetB.fetterVal || 0) + addExp;
                    totalSilverGain += addMoney;
                    propList.push({
                        beautyId: Number(targetB.beautyId),
                        addExp: addExp,
                        addMoney: addMoney,
                        isCrit: isCrit
                    });
                    if (updatedBeauties.indexOf(targetB) < 0) updatedBeauties.push(targetB);
                }
                st.beautyEnergy = Math.max(0, curEnergy - runs);
                st.beautyEnergyTime = now;
                if (totalSilverGain > 0) {
                    st.silver = addBigNumStr(st.silver, totalSilverGain);
                }
                saveState(st);
                this._push(4308, uid, { ret: 0, beautyPropagateList: propList });
                if (updatedBeauties.length > 0) this._push(4302, uid, { beautyList: updatedBeauties });
                this._push(4307, uid, { energy: st.beautyEnergy, lastRestoreTime: st.beautyEnergyTime });
                this._pushAttrs(st);
                return;
            }
            case 24309: { // S_BEAUTY_RECOVER_ENERGY
                st.beautyEnergy = Math.min(99, Number(st.beautyEnergy || 0) + 10);
                st.beautyEnergyTime = now;
                saveState(st);
                this._push(4309, uid, { ret: 0 });
                this._push(4307, uid, { energy: st.beautyEnergy, lastRestoreTime: st.beautyEnergyTime });
                return;
            }

            // ---------------- TV STUDIO / TRƯỜNG QUAY (Bug 5.1 Fix!) ----------------
            case 24701: { // S_TV_STUDIO_DATA
                if (!st.tvStudio || !st.tvStudio.studios || st.tvStudio.studios.length === 0) {
                    st.tvStudio = createDefaultTvStudios(st);
                }
                this._push(4701, uid, {
                    ret: 0,
                    studios: st.tvStudio.studios,
                    practiceRoomLevel: st.tvStudio.practiceRoomLevel || 1,
                    beautyExchangeCounts: [],
                    telecastNum: st.tvStudio.telecastNum || 0
                });
                return;
            }
            case 24704: // S_TV_STUDIO_ACTION
            case 24705: // S_TV_STUDIO_SHOT
            case 24706: // S_TV_STUDIO_COMPLETE
            case 24720: // S_TV_STUDIO_UNLOCK
            case 24728: // S_TV_STUDIO_GET_SCRIPT
            case 24730: { // S_TV_STUDIO_QUICK_SHOT
                if (!st.tvStudio) st.tvStudio = createDefaultTvStudios(st);
                var sIdx = Math.max(0, Number(req.studioIndex || 1) - 1);
                var studio = st.tvStudio.studios[sIdx] || st.tvStudio.studios[0];
                if (cmdId === 24705 || cmdId === 24730) {
                    studio.progress = Math.min(100, Number(studio.progress || 0) + 34);
                    studio.shotCount = Number(studio.shotCount || 0) + 1;
                    if (studio.progress >= 100) studio.state = 2;
                } else if (cmdId === 24706) {
                    studio.progress = 0;
                    studio.state = 1;
                    st.tvStudio.telecastNum = Number(st.tvStudio.telecastNum || 0) + 1;
                    grantRewardString(st, "101000=50000;101001=100;101002=50");
                } else if (cmdId === 24728 || cmdId === 24704) {
                    studio.state = 1;
                    studio.progress = 0;
                }
                saveState(st);
                if (cmdId === 24730) {
                    this._push(4730, uid, { ret: 0, studios: [] });
                } else if (cmdId === 24706) {
                    this._push(4706, uid, {
                        ret: 0,
                        studio: studio,
                        beautyArtEffect: [],
                        telecastNum: st.tvStudio.telecastNum,
                        reward: "101000=50000;101001=100;101002=50"
                    });
                    this._pushAttrs(st);
                } else {
                    this._push(recvId, uid, { ret: 0, studio: studio, beautyArtEffect: [], beautyExchangeCounts: [] });
                }
                return;
            }

            // ---------------- PROMOTE / TRUNG TÂM QUẢNG CÁO (Bug 5.2 Fix!) ----------------
            case 26651: { // S_PROMOTE_INFO_DATA
                if (!st.promote) st.promote = createDefaultPromote(st.serverId === 1);
                this._push(6651, uid, {
                    ret: 0,
                    departmentInfo: st.promote.departmentInfo,
                    count: st.promote.count || 0,
                    historyConsume: String(st.promote.historyConsume || "0"),
                    addition: String(st.promote.addition || "100")
                });
                return;
            }
            case 26652: { // S_PROMOTE_REQ_DATA
                if (!st.promote) st.promote = createDefaultPromote(st.serverId === 1);
                var pCnt = Math.max(1, Number(req.count || 1));
                st.promote.count = Number(st.promote.count || 0) + pCnt;
                st.promote.historyConsume = addBigNumStr(st.promote.historyConsume, pCnt * 1000);
                var depts = st.promote.departmentInfo || [];
                for (var dp = 0; dp < depts.length; dp++) {
                    depts[dp].count = Number(depts[dp].count || 0) + pCnt;
                    depts[dp].currentLvCount = Number(depts[dp].currentLvCount || 0) + pCnt;
                }
                var pRew = "101000=" + (5000 * pCnt) + ";101002=" + (20 * pCnt);
                grantRewardString(st, pRew);
                saveState(st);
                this._push(6652, uid, { ret: 0 });
                this._push(6653, uid, {
                    departmentInfo: depts,
                    reward: pRew,
                    travelEnergy: 10,
                    publicizeEnergy: 10,
                    beautyInfluenceInfo: [],
                    count: st.promote.count,
                    promoteSort: depts,
                    historyConsume: String(st.promote.historyConsume)
                });
                this._pushAttrs(st);
                return;
            }
            case 26654: { // S_PROMOTE_UPGRADE
                if (!st.promote) st.promote = createDefaultPromote(st.serverId === 1);
                var depId = Number(req.departmentId || 1);
                var dep = null;
                for (var di2 = 0; di2 < st.promote.departmentInfo.length; di2++) {
                    if (Number(st.promote.departmentInfo[di2].id) === depId) {
                        dep = st.promote.departmentInfo[di2];
                        dep.level = Number(dep.level || 1) + 1;
                        dep.currentLvCount = 0;
                        break;
                    }
                }
                saveState(st);
                this._push(6654, uid, { ret: 0, departmentInfo: dep || st.promote.departmentInfo[0] });
                return;
            }
            case 26655: { // S_PROMOTE_RECEIVE_LEVEL_REWARD
                if (!st.promote) st.promote = createDefaultPromote(st.serverId === 1);
                var rDepId = Number(req.departmentId || 1);
                var rDep = st.promote.departmentInfo[0];
                for (var di3 = 0; di3 < st.promote.departmentInfo.length; di3++) {
                    if (Number(st.promote.departmentInfo[di3].id) === rDepId) {
                        rDep = st.promote.departmentInfo[di3];
                        rDep.middleReward = true;
                        rDep.highReward = true;
                        break;
                    }
                }
                var prRew = "101001=200;101000=50000";
                grantRewardString(st, prRew);
                saveState(st);
                this._push(6655, uid, { ret: 0, reward: prRew, departmentInfo: rDep });
                this._pushAttrs(st);
                return;
            }
            case 26656: { // S_PROMOTE_RANK
                this._push(6656, uid, { ret: 0, rankInfo: [] });
                return;
            }

            // ---------------- TURNTABLE LOTTERY / QUÀ MAY MẮN & NEWBIE TARGET (Bug 9 Fix!) ----------------
            case 22004: { // S_TURNTABLE_LOTTERY
                var lType = Number(req.type || 1);
                var draws = lType === 2 ? 10 : 1;
                var lRews = [];
                var lLevels = [];
                var pool = ["101001=200", "101000=50000", "101003=20000", "110001=10", "110008=10", "101002=100"];
                for (var dr = 0; dr < draws; dr++) {
                    var pick = pool[Math.floor(Math.random() * pool.length)];
                    lRews.push(pick);
                    lLevels.push(1);
                    grantRewardString(st, pick);
                }
                st.lottery = st.lottery || { luckyValue: 0, records: [] };
                st.lottery.luckyValue = Number(st.lottery.luckyValue || 0) + draws * 10;
                saveState(st);
                this._push(2004, uid, { ret: 0, reward: lRews, luckyValue: st.lottery.luckyValue, rewardLevel: lLevels });
                this._pushAttrs(st);
                this._pushBag(st);
                return;
            }
            case 2001051: { // S_NEWBIE_TARGET_INFO
                this._push(1001051, uid, { ret: 0, newbie: st.newbieTarget });
                return;
            }
            case 2001052: { // S_NEWBIE_TARGET_SUBMIT
                st.newbieTarget.stageId = Number(st.newbieTarget.stageId || 1) + 1;
                st.newbieTarget.submit = true;
                var ntRew = "101001=500;101000=100000";
                grantRewardString(st, ntRew);
                saveState(st);
                this._push(1001052, uid, { ret: 0, newbie: st.newbieTarget, reward: ntRew });
                this._pushAttrs(st);
                return;
            }

            // ---------------- CARS / XE CỘ (Bug 10.1 Fix!) ----------------
            case 24204: { // S_CAR_UPGRADE
                var car = st.cars[String(req.carId)];
                if (car) {
                    car.level = Number(car.level || 1) + Math.max(1, Number(req.times || 1));
                    saveState(st);
                    this._push(4204, uid, { ret: 0, car: car });
                    this._push(4202, uid, { carList: [car] });
                    this._pushHeroAbilities(st);
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
                    this._pushHeroAbilities(st);
                } else {
                    this._push(4208, uid, { ret: 0 });
                }
                return;
            }
            case 24210: { // S_CAR_SHOW
                var showCid = String(req.carId || "");
                for (var sck in st.cars) {
                    if (st.cars.hasOwnProperty(sck)) st.cars[sck].isShow = (sck === showCid);
                }
                saveState(st);
                this._push(4210, uid, { ret: 0, carId: showCid });
                return;
            }
            case 24213: // S_CAR_STATUS
            case 24215: // S_CAR_GAIN_TEMPLATE
            case 24216: { // S_CAR_DRESS_SKIN
                this._push(recvId, uid, { ret: 0 });
                return;
            }

            // ---------------- HOUSE / NHÀ (Bug 10.2 Fix!) ----------------
            case 24001: // S_HOUSE_ROOM_DETAIL
            case 24003: // S_HOUSE_FURNITURE_LIST
            case 24004: // S_HOUSE_CLEAN
            case 24009: // S_HOUSE_COMFORT_UPGRADE
            case 24010: // S_HOUSE_SET_SHOW
            case 24011: // S_HOUSE_CHANGE_ROOM_STATUS
            case 24012: // S_HOUSE_UNLOCK_FURNITURE
            case 24013: { // S_HOUSE_CHANGE_FURNITURE_STATUS
                if (cmdId === 24009) {
                    st.houseComfortLevel = Number(st.houseComfortLevel || 1) + 1;
                    saveState(st);
                    this._push(4009, uid, { ret: 0, level: st.houseComfortLevel });
                } else if (cmdId === 24010 && req.houseId) {
                    for (var hi2 = 0; hi2 < (st.houses || []).length; hi2++) {
                        st.houses[hi2].isShow = (Number(st.houses[hi2].houseId) === Number(req.houseId));
                    }
                    saveState(st);
                    this._push(4010, uid, { ret: 0 });
                } else if (cmdId === 24001) {
                    var targetHouse = (st.houses && st.houses[0]) ? st.houses[0] : null;
                    var targetRoom = (targetHouse && targetHouse.roomList && targetHouse.roomList[0])
                        ? targetHouse.roomList[0]
                        : { houseId: Number(req.houseId || 1001), roomId: Number(req.roomId || 10011), furnitureList: [], isCleanUp: true, cleanItems: [], status: 1 };
                    this._push(4001, uid, { roomDetail: targetRoom });
                } else if (cmdId === 24003) {
                    this._push(4003, uid, { furnitureList: [], unlockableFurnitureList: [] });
                } else if (cmdId === 24004) {
                    this._push(4004, uid, { ret: 0, itemId: req.itemId || [] });
                } else {
                    this._push(recvId, uid, { ret: 0 });
                }
                return;
            }

            // ---------------- DANCE HALL / VŨ TRƯỜNG (Bug 10.3 Fix!) ----------------
            case 26501: { // S_DANCE_HALL_INFO
                if (!st.danceHall) st.danceHall = createDefaultDanceHall(st.serverId === 1);
                this._push(6501, uid, {
                    ret: 0,
                    level: st.danceHall.level,
                    energy: st.danceHall.energy,
                    lastRecoverEnergyAt: st.danceHall.lastRecoverEnergyAt,
                    setting: st.danceHall.setting
                });
                return;
            }
            case 26502: { // S_DANCE_HALL_UPGRADE
                if (!st.danceHall) st.danceHall = createDefaultDanceHall(st.serverId === 1);
                st.danceHall.level = Number(st.danceHall.level || 0) + 1;
                saveState(st);
                this._push(6502, uid, { ret: 0, newLevel: st.danceHall.level });
                return;
            }
            case 26503: { // S_DANCE_HALL_UPGRADE_SETTING
                if (!st.danceHall) st.danceHall = createDefaultDanceHall(st.serverId === 1);
                var dhSid = Number(req.settingId || 1);
                var dhFound = false;
                for (var dhi = 0; dhi < st.danceHall.setting.length; dhi++) {
                    if (Number(st.danceHall.setting[dhi].settingId) === dhSid) {
                        st.danceHall.setting[dhi].level = Number(st.danceHall.setting[dhi].level || 0) + Math.max(1, Number(req.num || 1));
                        dhFound = true;
                        break;
                    }
                }
                if (!dhFound) st.danceHall.setting.push({ settingId: dhSid, level: 1 });
                saveState(st);
                this._push(6503, uid, { ret: 0, setting: st.danceHall.setting });
                return;
            }
            case 26504: { // S_DANCE_HALL_ENERGY
                if (!st.danceHall) st.danceHall = createDefaultDanceHall(st.serverId === 1);
                st.danceHall.energy = Number(st.danceHall.energy || 0) + Math.max(1, Number(req.count || 5));
                st.danceHall.lastRecoverEnergyAt = now;
                saveState(st);
                this._push(6504, uid, { ret: 0, energy: st.danceHall.energy, lastRecoverEnergyAt: now });
                return;
            }

            // ---------------- VIDEO HALL / RẠP PHIM (Bug 10.4 Fix!) ----------------
            case 27291: { // S_VIDEO_HALL_INFO
                if (!st.videoHall) st.videoHall = createDefaultVideoHall(st.serverId === 1);
                this._push(7291, uid, {
                    ret: 0,
                    level: st.videoHall.level,
                    energy: st.videoHall.energy,
                    lastRecoverEnergyAt: st.videoHall.lastRecoverEnergyAt,
                    areaId: st.videoHall.areaId,
                    video: st.videoHall.video
                });
                return;
            }
            case 27292: { // S_VIDEO_HALL_UNLOCK_AREA
                if (!st.videoHall) st.videoHall = createDefaultVideoHall(st.serverId === 1);
                var vhAid = Number(req.areaId || 1);
                if (st.videoHall.areaId.indexOf(vhAid) < 0) st.videoHall.areaId.push(vhAid);
                saveState(st);
                this._push(7292, uid, { ret: 0, areaId: st.videoHall.areaId });
                return;
            }
            case 27293: { // S_VIDEO_HALL_UPGRADE
                if (!st.videoHall) st.videoHall = createDefaultVideoHall(st.serverId === 1);
                st.videoHall.level = Number(st.videoHall.level || 0) + 1;
                saveState(st);
                this._push(7293, uid, { ret: 0, newLevel: st.videoHall.level, areaId: st.videoHall.areaId });
                return;
            }
            case 27294: { // S_VIDEO_HALL_UPGRADE_VIDEO
                if (!st.videoHall) st.videoHall = createDefaultVideoHall(st.serverId === 1);
                var vhVid = Number(req.videoId || 1);
                var vhFound = false;
                for (var vhi = 0; vhi < st.videoHall.video.length; vhi++) {
                    if (Number(st.videoHall.video[vhi].videoId) === vhVid) {
                        st.videoHall.video[vhi].level = Number(st.videoHall.video[vhi].level || 0) + Math.max(1, Number(req.num || 1));
                        vhFound = true;
                        break;
                    }
                }
                if (!vhFound) st.videoHall.video.push({ videoId: vhVid, level: 1 });
                saveState(st);
                this._push(7294, uid, { ret: 0, video: st.videoHall.video });
                return;
            }
            case 27295: { // S_VIDEO_HALL_ENTER
                this._push(7295, uid, { ret: 0, customer: [], receptionIncomeCount: 10000 });
                return;
            }
            case 27296: { // S_VIDEO_HALL_EXIT
                this._push(7296, uid, { ret: 0 });
                return;
            }

            // ---------------- FISH STORE / QUẦY CÁ (Bug 10.5 Fix: Chế biến + Nhập hàng!) ----------------
            case 27101: // S_FISH_STORE_GAME_START
            case 27102: // S_FISH_STORE_GAME_ACTION
            case 27103: // S_FISH_STORE_GAME_EXIT
            case 27104: // S_FISH_STORE_SCENE
            case 27105: // S_FISH_STORE_SALE
            case 27106: // S_FISH_STORE_LEVEL_UP
            case 27107: // S_FISH_STORE_FISH_LEVEL_UP
            case 27108: // S_FISH_STORE_AREA_UNLOCK
            case 27109: // S_FISH_STORE_PROCESS_LEVEL_UP (Chế biến!)
            case 27110: // S_FISH_STORE_GET_REWARD
            case 27111: // S_FISH_STORE_POWER_RECOVER
            case 27112: { // S_FISH_STORE_FAST_STOCK_UP (Nhập hàng!)
                if (!st.fishStore) st.fishStore = createDefaultFishStore(st.serverId === 1);
                var fs = st.fishStore;
                if (cmdId === 27106) {
                    fs.level = Number(fs.level || 1) + 1;
                } else if (cmdId === 27107) {
                    var fid = Number(req.fishId || 1);
                    var fFound = false;
                    for (var fi = 0; fi < fs.fishes.length; fi++) {
                        if (Number(fs.fishes[fi].fishId) === fid || req.all) {
                            fs.fishes[fi].level = Number(fs.fishes[fi].level || 1) + 1;
                            if (Number(fs.fishes[fi].fishId) === fid) fFound = true;
                        }
                    }
                    if (!fFound && fid > 0) fs.fishes.push({ fishId: fid, level: 1 });
                } else if (cmdId === 27108) {
                    var aid = Number(req.areaId || 1);
                    var aFound = fs.areas.some(function (a) { return Number(a.areaId) === aid; });
                    if (!aFound && aid > 0) fs.areas.push({ areaId: aid });
                } else if (cmdId === 27109) { // Process Level Up (Chế biến!)
                    var pid = Number(req.processId || 1);
                    var pFound = false;
                    for (var pi = 0; pi < fs.processes.length; pi++) {
                        if (Number(fs.processes[pi].processId) === pid) {
                            fs.processes[pi].level = Number(fs.processes[pi].level || 0) + 1;
                            pFound = true;
                            break;
                        }
                    }
                    if (!pFound && pid > 0) fs.processes.push({ processId: pid, level: 1 });
                } else if (cmdId === 27111) {
                    fs.stockUpPower = Number(fs.stockUpPower || 0) + Math.max(5, Number(req.num || 1) * 5);
                    fs.lastStockUpPowerTime = now;
                } else if (cmdId === 27112 || cmdId === 27103) { // Nhập hàng (Fast Stock Up / Exit Game)!
                    var stockRews = [];
                    var fPool = fs.fishes.length > 0 ? fs.fishes : [{ fishId: 1, level: 1 }];
                    fs.stock = fs.stock || { fishes: [] };
                    for (var sf = 0; sf < fPool.length; sf++) {
                        var sFid = Number(fPool[sf].fishId);
                        var addN = 25;
                        stockRews.push({ fishId: sFid, num: addN });
                        var stF = null;
                        for (var k = 0; k < fs.stock.fishes.length; k++) {
                            if (Number(fs.stock.fishes[k].fishId) === sFid) { stF = fs.stock.fishes[k]; break; }
                        }
                        if (stF) stF.num = Number(stF.num || 0) + addN;
                        else fs.stock.fishes.push({ fishId: sFid, num: addN });
                    }
                    fs.stockUp = Number(fs.stockUp || 0) + 1;
                    fs.stockUpPower = Math.max(0, Number(fs.stockUpPower || 10) - 1);
                    saveState(st);
                    this._push(recvId, uid, { ret: 0, fishReward: stockRews });
                    this._push(7100, uid, fs);
                    return;
                } else if (cmdId === 27105 || cmdId === 27110) {
                    fs.saleFishNum = Number(fs.saleFishNum || 0) + Math.max(1, Number(req.num || 5));
                    fs.popularity = Number(fs.popularity || 0) + 500;
                    grantItem(st, 101000, 50000);
                    saveState(st);
                    if (cmdId === 27110) {
                        this._push(7110, uid, { ret: 0, customerNum: 5, totalFishMoney: 50000, details: [{ fishId: 1, num: 5, fishMoney: 50000 }] });
                    } else {
                        this._push(7105, uid, { ret: 0 });
                    }
                    this._push(7100, uid, fs);
                    this._pushAttrs(st);
                    return;
                } else if (cmdId === 27101) {
                    this._push(7101, uid, { ret: 0, gameData: { board: [], power: Math.max(10, fs.stockUpPower || 10), basket: [] } });
                    return;
                }
                saveState(st);
                this._push(recvId, uid, { ret: 0 });
                this._push(7100, uid, fs);
                return;
            }

            // ---------------- LESSON TRAIN / ĐÀO TẠO (Bug 11.4 Fix!) ----------------
            case 22300: { // S_LESSON_TRAIN
                if (!st.train) st.train = createDefaultTrain(st.serverId === 1);
                this._push(2300, uid, {
                    ret: 0,
                    level: st.train.level,
                    seats: st.train.seats,
                    lessons: st.train.lessons,
                    heroInLesson: st.train.heroInLesson || 0,
                    lessonStartTime: st.train.lessonStartTime || 0,
                    studyingLesson: st.train.studyingLesson || 0,
                    lessonTimes: st.train.lessonTimes || 0,
                    repute: st.train.repute || 0
                });
                return;
            }
            case 22301: { // S_TRAIN_HERO_SIT_DOWN
                if (!st.train) st.train = createDefaultTrain(st.serverId === 1);
                var hIds = Array.isArray(req.heroIds) ? req.heroIds : [];
                var sIds = Array.isArray(req.seatIds) ? req.seatIds : [];
                var updSeats = [];
                for (var ti2 = 0; ti2 < hIds.length; ti2++) {
                    var seatId = Number(sIds[ti2] || (ti2 + 1));
                    var seatObj = null;
                    for (var sj = 0; sj < st.train.seats.length; sj++) {
                        if (Number(st.train.seats[sj].seatId) === seatId) { seatObj = st.train.seats[sj]; break; }
                    }
                    if (!seatObj) {
                        seatObj = { seatId: seatId, heroId: 0, heroStartTime: 0, heroMaxEndTime: 0, completedMillis: 0 };
                        st.train.seats.push(seatObj);
                    }
                    seatObj.heroId = Number(hIds[ti2]);
                    seatObj.heroStartTime = now;
                    seatObj.heroMaxEndTime = now + 3600000;
                    seatObj.completedMillis = 3600000;
                    updSeats.push(seatObj);
                }
                saveState(st);
                this._push(2301, uid, { ret: 0, updateSeats: updSeats });
                return;
            }
            case 22302: { // S_TRAIN_HERO_COMPLETE
                if (!st.train) st.train = createDefaultTrain(st.serverId === 1);
                var heroRews = [];
                var updC = [];
                for (var cj = 0; cj < st.train.seats.length; cj++) {
                    var sc = st.train.seats[cj];
                    if (sc.heroId > 0 && (req.oneClickFinish || Number(sc.seatId) === Number(req.seatId))) {
                        heroRews.push({ heroId: sc.heroId, gotBaiYeExp: 500, gotStudyExp: 500, timeDuration: 3600, gotSpecialExp: 200 });
                        sc.heroId = 0;
                        sc.heroStartTime = 0;
                        sc.heroMaxEndTime = 0;
                        updC.push(sc);
                    }
                }
                st.train.repute = Number(st.train.repute || 0) + 100 * Math.max(1, heroRews.length);
                grantItem(st, 101003, 5000 * Math.max(1, heroRews.length));
                saveState(st);
                this._push(2302, uid, {
                    ret: 0,
                    itemReward: "101003=" + (5000 * Math.max(1, heroRews.length)),
                    heroRewards: heroRews,
                    updateSeats: updC,
                    addRepute: 100 * Math.max(1, heroRews.length)
                });
                this._pushAttrs(st);
                return;
            }
            case 22303: { // S_TRAIN_UNLOCK_SEAT
                if (!st.train) st.train = createDefaultTrain(st.serverId === 1);
                var newSid = st.train.seats.length + 1;
                var ns = { seatId: newSid, heroId: 0, heroStartTime: 0, heroMaxEndTime: 0, completedMillis: 0 };
                st.train.seats.push(ns);
                saveState(st);
                this._push(2303, uid, { ret: 0, newSeat: ns });
                return;
            }
            case 22304: { // S_TRAIN_ROOM_LEVEL_UP
                if (!st.train) st.train = createDefaultTrain(st.serverId === 1);
                st.train.level = Number(st.train.level || 1) + 1;
                saveState(st);
                this._push(2304, uid, { ret: 0, level: st.train.level });
                return;
            }

            // ---------------- HAPPY52 / AI LÀ TỶ PHÚ (Bug 11.2 Fix!) ----------------
            case 24021: { // S_HAPPY52_MAIN_VIEW
                this._push(4021, uid, {
                    divisionNumber: [{ division: 1, number: 10 }, { division: 2, number: 20 }, { division: 3, number: 30 }],
                    helpingCalls: [],
                    myRank: Number(st.happy52.myRank || 5),
                    remainDailyChallengeCount: Number(st.happy52.remainDailyChallengeCount || 20),
                    rankReward: { ret: 0, ranks: st.happy52.claimedRanks || [] },
                    myMaxRank: Number(st.happy52.myMaxRank || 5),
                    dailyReward: Number(st.happy52.dailyReward || 0),
                    marquees: []
                });
                return;
            }
            case 24022: { // S_HAPPY52_OPPONENT
                this._push(4022, uid, { opponents: buildNpcOpponents(st, 5) });
                return;
            }
            case 24023: { // S_HAPPY52_RANK
                this._push(4023, uid, { level: Number(req.level || 1), rankList: buildNpcOpponents(st, 5) });
                return;
            }
            case 24024: { // S_HAPPY52_RANK_REWARD
                var hrk = Number(req.rank || 1);
                if (st.happy52.claimedRanks.indexOf(hrk) < 0) st.happy52.claimedRanks.push(hrk);
                grantRewardString(st, "101001=500;101000=100000");
                saveState(st);
                this._push(4024, uid, { ret: 0, ranks: st.happy52.claimedRanks });
                this._pushAttrs(st);
                return;
            }
            case 24026: { // S_HAPPY52_CHALLENGE (NPC battle win!)
                var oldRk = Number(st.happy52.myRank || 10);
                var newRk = Math.max(1, oldRk - 1);
                st.happy52.myRank = newRk;
                st.happy52.myMaxRank = Math.min(Number(st.happy52.myMaxRank || oldRk), newRk);
                st.happy52.remainDailyChallengeCount = Math.max(1, Number(st.happy52.remainDailyChallengeCount || 20) - 1);
                grantRewardString(st, "101000=50000;101001=100");
                saveState(st);
                this._push(4026, uid, {
                    ret: 0,
                    isWin: true,
                    enemyIsNpc: true,
                    npcId: Number(req.targetId || 900001),
                    enemyPatronsList: [createHeroObj(102240, 10, 1, 0, 0, now)],
                    rank: newRk,
                    beforeRank: oldRk,
                    beforeMaxRank: oldRk,
                    reward: [{ id: 101000, count: 50000 }, { id: 101001, count: 100 }],
                    remainDailyChallengeCount: st.happy52.remainDailyChallengeCount,
                    battleDetailList: { battleDetailList: [] },
                    furniture: [],
                    unlockHouse: [],
                    levelReward: []
                });
                this._pushAttrs(st);
                return;
            }
            case 24027: { // S_HAPPY52_ANSWER
                grantItem(st, 101001, 50);
                saveState(st);
                this._push(4027, uid, { ret: 0, correct: true, reward: [{ id: 101001, count: 50 }], helpingCalls: [] });
                this._pushAttrs(st);
                return;
            }
            case 24030: { // S_HAPPY52_DAILY_REWARD
                st.happy52.dailyReward = 1;
                grantRewardString(st, "101001=300;101000=50000");
                saveState(st);
                this._push(4030, uid, { ret: 0, reward: [{ id: 101001, count: 300 }, { id: 101000, count: 50000 }] });
                this._pushAttrs(st);
                return;
            }

            // ---------------- BUSINESS WAR / THƯƠNG CHIẾN (Bug 11.3 Fix: Offline NPC Battle!) ----------------
            case 24901: { // S_BIZ_WAR_INFO
                this._push(4901, uid, {
                    level: Number(st.bizWar.level || 1),
                    rankNum: 1,
                    bussLevel: Number(st.bizWar.bussLevel || 1),
                    lastGetRewardTime: Number(st.bizWar.lastGetRewardTime || 0),
                    rankTopPlayer: buildPlayerBrief(st),
                    seasonEndTime: now + 7 * 86400000,
                    seasonSettleTime: now + 7 * 86400000,
                    frequency: Number(st.bizWar.frequency || 20)
                });
                return;
            }
            case 24903: // S_BIZ_WAR_BATTLE
            case 24906: { // S_BIZ_WAR_CHANGE_ENEMY
                var myHIds = Array.isArray(req.heroIdList) && req.heroIdList.length > 0
                    ? req.heroIdList
                    : Object.keys(st.heroes).slice(0, 6).map(Number);
                var enemyHeroes = [
                    createHeroObj(102210, 20, 2, 1, 0, now),
                    createHeroObj(102240, 20, 2, 1, 0, now)
                ];
                var bInfo = {
                    myPatronsIdList: myHIds,
                    myScore: Number(st.bizWar.score || 100),
                    buyBuffTimes: 0,
                    enemyUserId: 900101,
                    enemyNickName: "Đối Thủ Thương Trường (NPC)",
                    enemyTitleId: Math.max(1, Number(st.titleId || 10) - 1),
                    enemyDecoration: JSON.stringify({ 1: 106110, 3: 106010 }),
                    enemyScore: Math.max(50, Number(st.bizWar.score || 100) - 20),
                    enemyVipExp: 5000,
                    enemyPatronsCount: enemyHeroes.length,
                    enemyCity: "TP.HCM",
                    warTimes: 1,
                    hideVipAndAddress: 0,
                    changeEnemyTimes: 0,
                    battleType: Number(req.battleType || 1),
                    enemyDanLevel: 1
                };
                st.bizWar.activeBattle = { battleInfo: bInfo, enemyHeroList: enemyHeroes };
                saveState(st);
                this._push(recvId, uid, {
                    ret: 0,
                    battleInfo: bInfo,
                    enemyHeroList: enemyHeroes,
                    enemyHeroAbility: "20000"
                });
                return;
            }
            case 24905: { // S_BIZ_WAR_BATTLE_START
                var ab = st.bizWar.activeBattle || {
                    battleInfo: { myPatronsIdList: Object.keys(st.heroes).slice(0, 6).map(Number) },
                    enemyHeroList: [createHeroObj(102240, 15, 1, 0, 0, now)]
                };
                st.bizWar.score = Number(st.bizWar.score || 100) + 50;
                st.bizWar.bussWarMoney = Number(st.bizWar.bussWarMoney || 500) + 500;
                var bwRew = "101000=80000;101001=100;101002=50";
                grantRewardString(st, bwRew);
                st.bizWar.activeBattle = null;
                saveState(st);
                this._push(4905, uid, {
                    ret: 0,
                    battleDetailList: { battleDetailList: [] },
                    heroIdList: ab.battleInfo.myPatronsIdList || [],
                    enemyHeroList: ab.enemyHeroList || [],
                    killHeroCount: (ab.enemyHeroList || []).length,
                    myAddScore: 50,
                    enemyLoseScore: 25,
                    reward: bwRew,
                    addEarnSpeed: 100,
                    useItemId: 0,
                    warTimes: 1,
                    addAbility: [100],
                    flag: 1
                });
                this._push(4902, uid, {
                    level: st.bizWar.level,
                    score: st.bizWar.score,
                    bussWarMoney: st.bizWar.bussWarMoney,
                    frequency: st.bizWar.frequency
                });
                this._pushAttrs(st);
                return;
            }
            case 24908: // S_BIZ_WAR_GET_REWARD
            case 24909: { // S_BIZ_WAR_UPGRADE
                if (cmdId === 24909) {
                    st.bizWar.level = Number(st.bizWar.level || 1) + 1;
                    st.bizWar.bussLevel = Number(st.bizWar.bussLevel || 1) + 1;
                }
                st.bizWar.lastGetRewardTime = now;
                var bwr = "101001=200;101000=50000";
                grantRewardString(st, bwr);
                saveState(st);
                this._push(recvId, uid, { ret: 0, reward: bwr, lastGetRewardTime: now });
                this._pushAttrs(st);
                return;
            }
            case 24918: { // S_BIZ_WAR_RANK
                this._push(4918, uid, { ret: 0, showRankInfos: [], myRank: 1 });
                return;
            }

            // ---------------- VIP REWARDS & PRIVILEGES (Bug 12.2 & 12.3 Fix!) ----------------
            case 25902: { // S_VIP_REWARD
                var vLv = Number(req.level || 0);
                st.vipRewardedLevels = st.vipRewardedLevels || [];
                var vipCfg = null;
                var vipIds = getDBTableIds("VipDB");
                for (var vi = 0; vi < vipIds.length; vi++) {
                    var vr = getDBRow("VipDB", vipIds[vi]);
                    if (vr && Number(vr.level) === vLv) { vipCfg = vr; break; }
                }
                var vDelta = {};
                if (vipCfg) {
                    if (vipCfg.rewards && vipCfg.rewards !== "0") grantRewardString(st, vipCfg.rewards, vDelta);
                    if (vipCfg.mainRewards && vipCfg.mainRewards !== "0") grantRewardString(st, vipCfg.mainRewards, vDelta);
                    if (vipCfg.reward && vipCfg.reward !== "0") grantRewardString(st, vipCfg.reward, vDelta);
                } else {
                    grantRewardString(st, "101001=" + (500 * Math.max(1, vLv)) + ";101000=" + (100000 * Math.max(1, vLv)), vDelta);
                }
                if (st.vipRewardedLevels.indexOf(vLv) < 0) {
                    st.vipRewardedLevels.push(vLv);
                }
                recalcEarnSpeed(st);
                saveState(st);
                this._push(5902, uid, { ret: 0 });
                this._push(5901, uid, { rewardedLevel: st.vipRewardedLevels });
                this._pushDelta(st, vDelta);
                this._pushBag(st);
                this._pushAttrs(st);
                this._pushEarnSpeed(st);
                return;
            }
            case 25203: { // S_PRIVILEGE_GET_REWARD
                var pType = Number(req.privilegedType || 1);
                buildPrivilegeList(st);
                if (st.privileges[pType]) {
                    st.privileges[pType].canGetReward = false;
                }
                var cashGain = 500 * pType;
                st.ingots = Number(st.ingots || 0) + cashGain;
                saveState(st);
                this._push(5203, uid, { ret: 0, cashNum: cashGain });
                this._push(5201, uid, { privilegedList: buildPrivilegeList(st) });
                this._pushAttrs(st);
                return;
            }
            case 25206: // S_PRIVILEGED_SPECIAL_GET_REWARD
            case 25207: { // S_PRIVILEGED_SPECIAL_INFO
                if (cmdId === 25206) {
                    grantRewardString(st, "101001=1000;101000=200000");
                    saveState(st);
                    this._push(5206, uid, { ret: 0, specialReceived: true, reward: "101001=1000;101000=200000" });
                    this._pushAttrs(st);
                } else {
                    this._push(5207, uid, { ret: 0, specialReceived: false });
                }
                return;
            }

            // ---------------- RANKINGS (Bug 10.7 Fix!) ----------------
            case 24501: { // S_RANK_TOP
                this._push(4501, uid, { rankType: Number(req.rankType || 1), rankTopList: [] });
                return;
            }
            case 24502: { // S_RANK_LIST
                var rType = Number(req.rankType || 1);
                var myVal = String(st.earnSpeed || "100000");
                var rList = [{
                    userId: String(st.userId),
                    playerBaseData: buildPlayerBrief(st),
                    value: myVal,
                    showName: st.nickName,
                    decoration: buildPlayerDataMsg(st).playerBaseData.decoration,
                    serverId: st.serverId || 1,
                    serverName: "S1 - Max Tester"
                }];
                var npcs = buildNpcOpponents(st, 5);
                for (var ni = 0; ni < npcs.length; ni++) {
                    rList.push({
                        userId: String(npcs[ni].id),
                        playerBaseData: npcs[ni].playerBaseData,
                        value: String(npcs[ni].earnSpeed),
                        showName: npcs[ni].playerBaseData.nickName,
                        decoration: npcs[ni].playerBaseData.decoration,
                        serverId: 1,
                        serverName: "S1"
                    });
                }
                this._push(4502, uid, {
                    rankType: rType,
                    type: Number(req.type || 1),
                    rankList: rList,
                    myRank: 1,
                    myValue: myVal,
                    ret: 0
                });
                return;
            }
            case 24503: // S_RANK_WORSHIP
            case 24504: {
                grantItem(st, 101001, 100);
                saveState(st);
                this._push(recvId, uid, { ret: 0 });
                this._pushAttrs(st);
                return;
            }

            // ---------------- TASKS / QUESTS / GUIDEBOOK (Bug 10.6 & 10.7 Fix!) ----------------
            case 21205: { // S_TASK_GET_REWARD
                var tid = Number(req.taskId);
                var task = st.tasks[tid];
                var dbUtilT = getDBUtil();
                var cfgT = (dbUtilT && dbUtilT.getTask) ? dbUtilT.getTask(tid) : null;
                if (task) {
                    task.state = 1;
                    task.finishTime = Math.floor(now / 1000);
                } else {
                    task = { taskId: tid, value: "1", state: 1, finishTime: Math.floor(now / 1000), taskStartTime: 0, taskEndTime: 0 };
                    st.tasks[tid] = task;
                }
                if (st.completeTaskIds.indexOf(tid) < 0) st.completeTaskIds.push(tid);

                var updatedBuildings = [];
                if (dbUtilT && dbUtilT.getStoreSetingListByBuildingId) {
                    for (var bKey in st.buildings) {
                        if (!st.buildings.hasOwnProperty(bKey)) continue;
                        var bObj = st.buildings[bKey];
                        var slT = [];
                        try { slT = dbUtilT.getStoreSetingListByBuildingId(Number(bKey)) || []; } catch (e) {}
                        for (var sIdx2 = 0; sIdx2 < slT.length; sIdx2++) {
                            if (Number(slT[sIdx2].unlockCondition) === tid) {
                                ensureBusinessInBuilding(bObj, slT[sIdx2].id);
                                if (updatedBuildings.indexOf(bObj) < 0) updatedBuildings.push(bObj);
                            }
                        }
                    }
                }

                var tDelta = {};
                if (cfgT && cfgT.rewards && cfgT.rewards !== "0") {
                    grantRewardString(st, cfgT.rewards, tDelta);
                } else if (!cfgT || Number(cfgT.type) !== 22) {
                    grantItem(st, 101000, 10000);
                    grantItem(st, 101001, 50);
                    grantItem(st, 101002, 10);
                }
                var nextId = cfgT && cfgT.nextTaskId ? Number(cfgT.nextTaskId) : 0;
                var nextTaskObj = null;
                if (nextId > 0) {
                    if (!cfgT || Number(cfgT.type) === 2) st.mainTaskId = nextId;
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
                this._pushDelta(st, tDelta);
                this._push(1203, uid, { taskActive: st.taskActive, rewardIndexList: st.taskActiveRewards || [] });
                this._pushAttrs(st);
                this._pushBag(st);
                return;
            }
            case 21206: { // S_TASK_ACTIVE_REWARD
                var rIdx = Number(req.index || req.rewardIndex || 1);
                st.taskActiveRewards = st.taskActiveRewards || [];
                if (st.taskActiveRewards.indexOf(rIdx) < 0) st.taskActiveRewards.push(rIdx);
                grantRewardString(st, "101001=200;101000=50000");
                saveState(st);
                this._push(1206, uid, { ret: 0 });
                this._push(1203, uid, { taskActive: st.taskActive || 0, rewardIndexList: st.taskActiveRewards });
                this._pushAttrs(st);
                return;
            }
            case 21208: { // S_TASK_ONE_KEY_GET_REWARD
                var ids = Array.isArray(req.taskId) ? req.taskId : [];
                var okDelta = {};
                var dbUtilO = getDBUtil();
                var rewParts = [];
                for (var oi = 0; oi < ids.length; oi++) {
                    var okTid = Number(ids[oi]);
                    var tObj = st.tasks[okTid];
                    if (tObj) tObj.state = 1;
                    if (st.completeTaskIds.indexOf(okTid) < 0) st.completeTaskIds.push(okTid);
                    var oCfg = (dbUtilO && dbUtilO.getTask) ? dbUtilO.getTask(okTid) : null;
                    if (oCfg && oCfg.rewards && oCfg.rewards !== "0") {
                        grantRewardString(st, oCfg.rewards, okDelta);
                        rewParts.push(oCfg.rewards);
                    } else {
                        grantItem(st, 101000, 5000);
                        grantItem(st, 101001, 50);
                        rewParts.push("101000=5000;101001=50");
                    }
                }
                saveState(st);
                this._push(1208, uid, { ret: 0, taskId: ids, reward: rewParts.join(";") || "101000=5000;101001=50" });
                this._pushDelta(st, okDelta);
                this._pushAttrs(st);
                this._pushBag(st);
                return;
            }

            // ---------------- BAG & ITEMS & VOUCHERS ----------------
            case 20602: { // S_BAG_USE_GOODS
                var gid = Number(req.goodsId);
                var cnt = Math.max(1, Number(req.count || 1));
                if (st.bag[gid] && gid !== GAME_TIMECOIN_ID) {
                    st.bag[gid] = Math.max(0, Number(st.bag[gid]) - cnt);
                }
                var rew = "101000=" + (cnt * 10000);
                var uDelta = {};
                grantRewardString(st, rew, uDelta);
                saveState(st);
                this._push(602, uid, { ret: 0, goodsId: gid, count: cnt, reward: rew, specialReward: false });
                this._pushDelta(st, uDelta);
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
            case 20605: { // S_BAG_VOUCHER_INFO (Infinite Vouchers!)
                ensureInfiniteVouchers(st);
                var vItems = [];
                var itemTblV = getDBTable("ItemDB");
                for (var vid in st.bag) {
                    if (!st.bag.hasOwnProperty(vid)) continue;
                    var vRow = itemTblV ? itemTblV[vid] : null;
                    var vType = vRow ? Number(vRow.itemType || 0) : 0;
                    if (Number(vid) === GAME_TIMECOIN_ID || vType === 133 || vType === 138) {
                        vItems.push({ goodsId: Number(vid), num: Number(st.bag[vid]), expiredTime: 0 });
                    }
                }
                this._push(605, uid, { msg: { itemList: vItems } });
                return;
            }

            // ---------------- SHOP & INFINITE VOUCHER PAID PACKS (Bug 11.1 & Req #2 Fix!) ----------------
            case 24101: { // S_SHOP_GET_GOODS_LIST
                var stype = Number(req.shopType || 1);
                var sList = [];
                var shopTbl = getDBTable("ShopDB");
                if (shopTbl) {
                    var sIds = getDBTableIds("ShopDB");
                    for (var si3 = 0; si3 < sIds.length; si3++) {
                        var sRow = shopTbl[sIds[si3]];
                        if (sRow && Number(sRow.shopType) === stype) sList.push(sIds[si3]);
                    }
                }
                this._push(4101, uid, { ret: 0, shopType: stype, shopGoodsList: sList });
                return;
            }
            case 24102: { // S_SHOP_BUY_GOODS (Bug 11.1 Fix: Read EXACT ShopDB[id].reward!)
                var sgid = Number(req.shopGoodsId || 0);
                var scnt = Math.max(1, Number(req.count || 1));
                var dbUS = getDBUtil();
                var sCfg = (dbUS && typeof dbUS.getShop === "function") ? dbUS.getShop(sgid) : null;
                if (!sCfg) sCfg = getDBRow("ShopDB", sgid);
                var exactRew = (sCfg && sCfg.reward && sCfg.reward !== "0")
                    ? multiplyRewardString(sCfg.reward, scnt)
                    : ("101001=" + (100 * scnt));
                var sDelta = {};
                grantRewardString(st, exactRew, sDelta);
                st.shopBought = st.shopBought || {};
                st.shopBought[sgid] = Number(st.shopBought[sgid] || 0) + scnt;
                recalcEarnSpeed(st);
                saveState(st);
                this._push(4102, uid, { ret: 0, shopGoodsId: sgid, count: scnt, goodsDeatil: exactRew });
                this._push(4103, uid, { shopBuyGoodsList: [{ shopGoodsId: sgid, buyCount: st.shopBought[sgid] }] });
                this._pushDelta(st, sDelta);
                this._pushBag(st);
                this._pushAttrs(st);
                this._pushEarnSpeed(st);
                return;
            }
            case 24104: { // S_SHOP_BUY_RECHARGE_ITEM (Buy ANY paid pack with infinite Thẻ Giảm Giá!)
                var rSgid = Number(req.shopGoodsId || 0);
                var boughtDetail = deliverShopPurchase(st, rSgid, 1, this, "offline_voucher_" + now, "", true);
                this._push(4104, uid, { ret: 0, shopGoodsId: rSgid, goodsDetail: boughtDetail });
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
                var mDelta = {};
                for (var mj = 0; mj < st.mails.length; mj++) {
                    var ml = st.mails[mj];
                    if (cmdId === 20304 || ml.mailUid === req.mailUid) {
                        if (!ml.isGetReward && ml.annexes) {
                            grantRewardString(st, ml.annexes, mDelta);
                            allRew.push(ml.annexes);
                        }
                        ml.isRead = true;
                        ml.isGetReward = true;
                    }
                }
                saveState(st);
                if (cmdId === 20304) this._push(304, uid, { ret: 0, reward: allRew.join(";") });
                else this._push(303, uid, { ret: 0 });
                this._push(307, uid, { mailList: st.mails });
                this._pushDelta(st, mDelta);
                this._pushAttrs(st);
                this._pushBag(st);
                return;
            }
            case 20305: // S_MAIL_DELETE_MAIL
            case 20306: { // S_MAIL_DELETE_ALL_MAIL
                if (cmdId === 20306) st.mails = st.mails.filter(function (m) { return !m.isGetReward; });
                else st.mails = st.mails.filter(function (m) { return m.mailUid !== req.mailUid; });
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
            case 24853: { // S_SIGN_ACCUMULATE_REWARD
                var accIdx = Number(req.index || 1);
                st.sign.gainedAccumulateIndex = st.sign.gainedAccumulateIndex || [];
                if (st.sign.gainedAccumulateIndex.indexOf(accIdx) < 0) st.sign.gainedAccumulateIndex.push(accIdx);
                var accRew = "101001=500;101000=50000";
                grantRewardString(st, accRew);
                saveState(st);
                this._push(4853, uid, { ret: 0, reward: accRew });
                this._pushAttrs(st);
                return;
            }

            // ---------------- CUSTOMERS ----------------
            case 24603: { // S_CUSTOMER_UNLOCK
                var uCid = Number(req.customerId || 0);
                if (uCid > 0) {
                    st.customers = st.customers || createDefaultCustomers();
                    st.customers[uCid] = { customerId: uCid, status: 2 };
                    saveState(st);
                    this._push(4603, uid, { ret: 0, customerId: uCid });
                    this._push(4602, uid, { customerList: [st.customers[uCid]] });
                } else {
                    this._push(4603, uid, { ret: 0, customerId: uCid });
                }
                return;
            }
            case 24604: { // S_CUSTOMER_UNLOCK_REWARD
                var rCid = Number(req.customerId || 0);
                var cRew = "101001=50";
                if (rCid > 0) {
                    st.customers = st.customers || createDefaultCustomers();
                    st.customers[rCid] = { customerId: rCid, status: 3 };
                    var dbU3 = getDBUtil();
                    if (dbU3 && dbU3.getCustomer) {
                        try {
                            var cCfg = dbU3.getCustomer(rCid);
                            if (cCfg && cCfg.unlockReward && cCfg.unlockReward !== "0") cRew = String(cCfg.unlockReward);
                        } catch (e) {}
                    }
                    grantRewardString(st, cRew);
                    saveState(st);
                    this._push(4604, uid, { ret: 0, customerId: rCid, reward: cRew });
                    this._push(4602, uid, { customerList: [st.customers[rCid]] });
                    this._pushAttrs(st);
                    this._pushBag(st);
                } else {
                    this._push(4604, uid, { ret: 0, customerId: rCid, reward: "" });
                }
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

    // =========================================================================
    // 9. Runtime Engine Patches (Offline RemoteResMgr, Anti-Freeze UI, Portraits, Audio, Vouchers)
    // =========================================================================
    var runtimePatchState = {
        remoteResPatched: false,
        uiMgrPatched: false,
        buildingBasePatched: false,
        guideBookPatched: false,
        spineFallbackPatched: false,
        audioPatched: false,
        rechargeConfigPatched: false,
        resetRolePatched: false,
        startPrivilegePatched: false
    };

    var BUNDLED_BGMS = [
        "activity/29_1/sound/bgm/Cmn",
        "activity/1015_1/sound/bgm/BgmActivity",
        "activity/1020_1/sound/bgm/BgmFarming",
        "activity/1025_1/sound/bgm/BgmFashion",
        "activity/1024_1/sound/bgm/BgmGongFu"
    ];
    var BUNDLED_SFXS = {
        click: "activity/1011_1/sound/sfx/LuckydrawClick",
        buy: "activity/1024_1/sound/sfx/GongfuBuy",
        money: "activity/29_1/sound/sfx/DiggoldMoney",
        reward: "activity/1011_1/sound/sfx/LuckydrawReach",
        defaultSfx: "activity/1011_1/sound/sfx/LuckydrawClick"
    };

    function mapAudioToBundled(url) {
        var u = String(url || "");
        if (u.indexOf("sound/bgm") >= 0 || u.indexOf("bgm") >= 0) {
            if (u.indexOf("Activity") >= 0) return BUNDLED_BGMS[1];
            if (u.indexOf("Farm") >= 0) return BUNDLED_BGMS[2];
            if (u.indexOf("Fashion") >= 0) return BUNDLED_BGMS[3];
            return BUNDLED_BGMS[0];
        }
        var lower = u.toLowerCase();
        if (lower.indexOf("coin") >= 0 || lower.indexOf("money") >= 0 || lower.indexOf("silver") >= 0 || lower.indexOf("gold") >= 0) {
            return BUNDLED_SFXS.money;
        }
        if (lower.indexOf("buy") >= 0 || lower.indexOf("shop") >= 0 || lower.indexOf("upgrade") >= 0 || lower.indexOf("level") >= 0) {
            return BUNDLED_SFXS.buy;
        }
        if (lower.indexOf("reward") >= 0 || lower.indexOf("get") >= 0 || lower.indexOf("win") >= 0 || lower.indexOf("success") >= 0) {
            return BUNDLED_SFXS.reward;
        }
        return BUNDLED_SFXS.click;
    }

    function resolvePortraitFallbackPath(spineUrl, I18nUtil) {
        var s = String(spineUrl || "");
        var m = s.match(/common\/spine\/(hero|beauty|skin|player|eudemon)(?:act)?\/(\d+)\//i);
        if (!m) return null;
        var kind = m[1].toLowerCase();
        var id = m[2];
        var candidates = [
            "common/" + kind + "/" + id + "/1",
            "common/" + kind + "/" + id + "/2",
            "common/" + kind + "/" + id + "/3",
            "common/" + kind + "/" + id + "/4",
            "common/" + kind + "/" + id + "/5"
        ];
        if (I18nUtil && typeof I18nUtil.isResValid === "function") {
            for (var i = 0; i < candidates.length; i++) {
                try {
                    if (I18nUtil.isResValid(candidates[i])) return candidates[i];
                } catch (e) {}
            }
        }
        return candidates[0];
    }

    function resolveLocalActSpinePath(spineUrl, I18nUtil) {
        if (!I18nUtil || typeof I18nUtil.isResValid !== "function") return null;
        var s = String(spineUrl || "").replace(/^assetsRemote\//, "");
        try {
            if (I18nUtil.isResValid(s)) return s;
        } catch (e) {}
        var m = s.match(/^common\/spine\/(hero|beauty|player)\/(\d+)\/(skeleton.*)$/i);
        if (m) {
            var actPath = "common/spine/" + m[1].toLowerCase() + "act/" + m[2] + "/" + m[3];
            try {
                if (I18nUtil.isResValid(actPath)) return actPath;
            } catch (e) {}
        }
        return null;
    }

    function attachPortraitSpriteToNode(targetNode, tex, targetHeight) {
        if (!targetNode || !global.cc || !global.cc.isValid(targetNode, true) || !tex) return;
        try {
            var old = targetNode.getChildByName("__OfflinePortrait__");
            if (old && global.cc.isValid(old, true)) {
                old.removeFromParent();
                old.destroy();
            }
            var spNode = new global.cc.Node("__OfflinePortrait__");
            var sprite = spNode.addComponent(global.cc.Sprite);
            sprite.spriteFrame = new global.cc.SpriteFrame(tex);
            sprite.sizeMode = global.cc.Sprite.SizeMode.RAW;
            var w = tex.width || 512;
            var h = tex.height || 512;
            var desiredH = targetHeight || 520;
            var scale = desiredH / Math.max(1, h);
            if (scale > 1.2) scale = 1.2;
            if (scale < 0.25) scale = 0.25;
            spNode.setAnchorPoint(0.5, 0.0);
            spNode.setPosition(0, 0);
            spNode.setScale(scale, scale);
            targetNode.addChild(spNode);
        } catch (e) {
            warn("attachPortraitSpriteToNode error:", e && e.message);
        }
    }

    function installRuntimePatches() {
        var i18nMod = getModule("I18nUtil");
        var I18nUtil = i18nMod && i18nMod.I18nUtil ? i18nMod.I18nUtil : null;

        // 9a. Patch RemoteResMgr so offline mode NEVER downloads from remote CDN or spams network errors
        if (!runtimePatchState.remoteResPatched) {
            try {
                var rrmMod = getModule("RemoteResMgr");
                var RRM = rrmMod && rrmMod.RemoteResMgr ? rrmMod.RemoteResMgr : null;
                if (RRM && RRM.prototype) {
                    var pkgCfgMod = getModule("PackagesConfig");
                    var REMOTE_PREFIX = (pkgCfgMod && pkgCfgMod.PackagesConfig && pkgCfgMod.PackagesConfig.REMOTE_PATH)
                        ? pkgCfgMod.PackagesConfig.REMOTE_PATH
                        : "assetsRemote/";

                    var stripRemote = function (u) {
                        var s = String(u || "");
                        return s.indexOf(REMOTE_PREFIX) === 0 ? s.substring(REMOTE_PREFIX.length) : s;
                    };

                    RRM.prototype.loadResManifest = function (pkgList, cb) {
                        if (Array.isArray(pkgList)) {
                            for (var i = 0; i < pkgList.length; i++) {
                                var pkg = pkgList[i];
                                if (!pkg) continue;
                                if (this.remoteResMap && !this.remoteResMap.has(pkg)) this.remoteResMap.set(pkg, {});
                                if (this.remoteCheckMap && !this.remoteCheckMap.has(pkg)) this.remoteCheckMap.set(pkg, {});
                                if (this.localResMap && !this.localResMap.has(pkg)) this.localResMap.set(pkg, {});
                            }
                        }
                        if (typeof cb === "function") cb(true);
                    };

                    RRM.prototype.checkRemoteFileExist = function () {
                        return Promise.resolve(false);
                    };

                    RRM.prototype.downloadRemoteRes = function (url, type, cb) {
                        if (typeof cb === "function") cb(false, null);
                    };

                    RRM.prototype.loadRemoteRes = function (url, type, cb, viewCache) {
                        if (this.resMap && this.resMap[url] && this.resMap[url][type]) {
                            var cached = this.resMap[url][type];
                            try { if (cached.addRef) cached.addRef(); } catch (e) {}
                            if (typeof cb === "function") cb(true, cached);
                            return;
                        }
                        if (type === ".manifest") {
                            if (typeof cb === "function") cb(true, { text: "{}" });
                            return;
                        }
                        var localUrl = stripRemote(url);
                        // Audio fallback for RemoteResMgr audio calls
                        if (type === ".mp3" || localUrl.indexOf("common/sound/") >= 0) {
                            var mappedAudio = (I18nUtil && I18nUtil.isResValid && I18nUtil.isResValid(localUrl))
                                ? localUrl
                                : mapAudioToBundled(localUrl);
                            if (global.cc && global.cc.resources && global.cc.AudioClip) {
                                var selfAudio = this;
                                global.cc.resources.load(mappedAudio, global.cc.AudioClip, function (err, clip) {
                                    if (!err && clip) {
                                        selfAudio.resMap[url] = selfAudio.resMap[url] || {};
                                        selfAudio.resMap[url][type] = clip;
                                        if (typeof cb === "function") cb(true, clip);
                                    } else {
                                        if (typeof cb === "function") cb(false, null);
                                    }
                                });
                                return;
                            }
                        }
                        if (localUrl && I18nUtil && typeof I18nUtil.isResValid === "function" && I18nUtil.isResValid(localUrl)) {
                            var selfRRM = this;
                            var assetType = (type === ".png" || type === ".jpg")
                                ? (global.cc && global.cc.Texture2D ? global.cc.Texture2D : null)
                                : (type === ".mp3"
                                    ? (global.cc && global.cc.AudioClip ? global.cc.AudioClip : null)
                                    : (global.cc && global.cc.Asset ? global.cc.Asset : null));
                            if (assetType && typeof I18nUtil.loadResWithType === "function") {
                                I18nUtil.loadResWithType(localUrl, assetType, function (err, asset) {
                                    if (!err && asset) {
                                        selfRRM.resMap[url] = selfRRM.resMap[url] || {};
                                        selfRRM.resMap[url][type] = asset;
                                        try { if (asset.addRef) asset.addRef(); } catch (e) {}
                                        if (typeof cb === "function") cb(true, asset);
                                    } else {
                                        if (typeof cb === "function") cb(false, null);
                                    }
                                });
                                return;
                            }
                        }
                        if (typeof cb === "function") cb(false, null);
                    };

                    var loadOfflineSpine = function (url, cb) {
                        var actUrl = resolveLocalActSpinePath(url, I18nUtil);
                        if (actUrl && I18nUtil && global.sp && global.sp.SkeletonData && typeof I18nUtil.loadResWithType === "function") {
                            I18nUtil.loadResWithType(actUrl, global.sp.SkeletonData, function (err, skelData) {
                                if (!err && skelData) {
                                    if (typeof cb === "function") cb(null, skelData);
                                } else {
                                    if (typeof cb === "function") cb(err || new Error("offline spine load failed"), null);
                                }
                            });
                            return;
                        }
                        if (typeof cb === "function") cb(new Error("offline remote spine unavailable: " + url), null);
                    };
                    RRM.prototype.loadRemoteSkelSpineResNoNode = loadOfflineSpine;
                    RRM.prototype.loadRemoteJsonSpineResNoNode = loadOfflineSpine;

                    runtimePatchState.remoteResPatched = true;
                    log("Patched RemoteResMgr for pure offline mode");
                }
            } catch (e) {
                warn("Patch RemoteResMgr failed:", e && e.message);
            }
        }

        // 9b. Freeze-proof UIMgr (open + removeFromLayer + showUnderView + missing remote view redirects!)
        if (!runtimePatchState.uiMgrPatched) {
            try {
                var uiMod = getModule("UIMgr");
                var UIMgrCls = uiMod && uiMod.UIMgr ? uiMod.UIMgr : null;
                if (UIMgrCls && UIMgrCls.prototype) {
                    var origOpen = UIMgrCls.prototype.open;
                    UIMgrCls.prototype.open = function (uiType, openData) {
                        var selfUI = this;
                        try {
                            var cname = (uiType && typeof uiType.getClassName === "function") ? uiType.getClassName() : "";
                            // Bug 2 Fix: CashPackHelperView uses remote-only FGUI pkg CashGiftPack -> redirect to ShopMainView!
                            if (cname === "CashPackHelperView") {
                                var shopMod = getModule("ShopMainView");
                                if (shopMod && shopMod.ShopMainView) {
                                    log("Redirecting CashPackHelperView -> ShopMainView");
                                    uiType = shopMod.ShopMainView;
                                    openData = openData || { intoData: {} };
                                }
                            }
                            // Unlock any stuck _isOpening / _isHiding before opening if a prior view hung
                            if (this._isOpening && this._lastOpenStartTime && (Date.now() - this._lastOpenStartTime > 2000)) {
                                warn("Auto-recovering stuck UIMgr._isOpening!");
                                this._isOpening = false;
                            }
                            this._lastOpenStartTime = Date.now();

                            var res = origOpen.call(this, uiType, openData);
                            // Safety watchdog: if a view fails to finish loading within 2500ms, never leave UIMgr frozen!
                            if (this._isOpening) {
                                var openStamp = this._lastOpenStartTime;
                                setTimeout(function () {
                                    if (selfUI._isOpening && selfUI._lastOpenStartTime === openStamp) {
                                        warn("Watchdog unlocking UIMgr._isOpening for " + cname);
                                        try { selfUI.openEnded(); } catch (e2) { selfUI._isOpening = false; }
                                        try {
                                            if (global.fgui && global.fgui.GRoot && global.fgui.GRoot.inst) {
                                                selfUI._isLocked = false;
                                                global.fgui.GRoot.inst.touchable = true;
                                            }
                                        } catch (e3) {}
                                    }
                                }, 2500);
                            }
                            return res;
                        } catch (err) {
                            warn("UIMgr.open error:", err && (err.stack || err.message || err));
                            try { this._isOpening = false; this.openEnded(); } catch (e4) { this._isOpening = false; }
                            try {
                                if (global.fgui && global.fgui.GRoot && global.fgui.GRoot.inst) {
                                    this._isLocked = false;
                                    global.fgui.GRoot.inst.touchable = true;
                                }
                            } catch (e5) {}
                            return null;
                        }
                    };

                    UIMgrCls.prototype.removeFromLayer = function (view) {
                        if (view && view.viewContainer) {
                            try { this.showUnderView(); } catch (err) {
                                warn("UIMgr.showUnderView error:", err && (err.stack || err.message || err));
                            }
                            try { this.removeMode(view); } catch (err2) {}
                            try { view.viewContainer.removeFromParent(); } catch (err3) {}
                            try {
                                if (!this._isLockedTime && global.fgui && global.fgui.GRoot && global.fgui.GRoot.inst) {
                                    this._isLocked = false;
                                    global.fgui.GRoot.inst.touchable = true;
                                }
                            } catch (err4) {}
                        }
                    };

                    var origShowUnderView = UIMgrCls.prototype.showUnderView;
                    UIMgrCls.prototype.showUnderView = function () {
                        var coreTypeMod = getModule("CoreTypeDefine");
                        var VT = coreTypeMod && coreTypeMod.ViewType ? coreTypeMod.ViewType : null;
                        var VST = coreTypeMod && coreTypeMod.ViewShowType ? coreTypeMod.ViewShowType : null;
                        if (!VT || !VST) return origShowUnderView.apply(this, arguments);
                        var skipTypes = [VT.Guide, VT.Loading, VT.Toast, VT.Top, VT.Edit];
                        for (var e = this._uuidList.length - 1; e >= 0; e--) {
                            var uuid = this._uuidList[e];
                            var mid = this._multiidList[e];
                            var v = this.getViewWith(uuid, mid);
                            if (v && v.openData) {
                                var r = v.openData.type;
                                if (skipTypes.indexOf(r) === -1) {
                                    if (!v.viewCloseSelfOnScreenOpen && !v.viewActivityLock && v.isHiding) {
                                        try {
                                            if (this._showingViewList && this._showingViewList.push) {
                                                this._showingViewList.push(v.cacheClassName);
                                            }
                                            v.showSelf();
                                        } catch (err) {
                                            warn("showUnderView failed on " + (v.uiGuideName || v.cacheClassName) + ":", err && err.message);
                                            try {
                                                v.isHiding = false;
                                                if (v.viewContainer) v.viewContainer.visible = true;
                                            } catch (e2) {}
                                        }
                                    }
                                    if (v.openData.showType == VST.Screen) break;
                                }
                            }
                        }
                    };

                    runtimePatchState.uiMgrPatched = true;
                    log("Patched UIMgr.open, removeFromLayer & showUnderView (anti-freeze + CashPack redirect)");
                }
            } catch (e) {
                warn("Patch UIMgr failed:", e && e.message);
            }
        }

        // 9b2. Bug 12.2 Fix: StartPrivilegeCmnUtil.openMain() uses remote-only startPrivilege pkg -> open PrivilegeMainView!
        if (!runtimePatchState.startPrivilegePatched) {
            try {
                var spMod = getModule("StartPrivilegeCmnUtil");
                var SPCU = spMod && spMod.StartPrivilegeCmnUtil ? spMod.StartPrivilegeCmnUtil : null;
                if (SPCU) {
                    SPCU.openMain = function () {
                        try {
                            var uiM = getModule("UIMgr");
                            var privMod = getModule("PrivilegeMainView") || getModule("PrivilegeYearCardView");
                            var targetView = (privMod && (privMod.PrivilegeMainView || privMod.PrivilegeYearCardView)) || null;
                            if (uiM && uiM.UIMgr && uiM.UIMgr.inst && targetView) {
                                log("Redirecting StartPrivilegeCmnUtil.openMain -> PrivilegeMainView");
                                uiM.UIMgr.inst.open(targetView);
                            }
                        } catch (err) {
                            warn("StartPrivilege redirect error:", err && err.message);
                        }
                    };
                    SPCU.isRedPoint = function (cb) { if (typeof cb === "function") cb(false); };
                    SPCU.requestInfo = function () {};
                    runtimePatchState.startPrivilegePatched = true;
                    log("Patched StartPrivilegeCmnUtil.openMain -> PrivilegeMainView");
                }
            } catch (e) {
                warn("Patch StartPrivilegeCmnUtil failed:", e && e.message);
            }
        }

        // 9c. Patch BuildingBaseView safe exit
        if (!runtimePatchState.buildingBasePatched) {
            try {
                var bbMod = getModule("BuildingBaseView");
                var BBV = bbMod && bbMod.BuildingBaseView ? bbMod.BuildingBaseView : null;
                if (BBV && BBV.prototype) {
                    var origSaveCust = BBV.prototype.saveCommonCustomerDataList;
                    if (typeof origSaveCust === "function") {
                        BBV.prototype.saveCommonCustomerDataList = function () {
                            try { return origSaveCust.apply(this, arguments); } catch (err) {}
                        };
                    }
                    if (typeof BBV.prototype.leaveBuilding === "function") {
                        BBV.prototype.leaveBuilding = function () {
                            try { this.doEnterStatus(this.buildingId, 0); } catch (err) {}
                            return this.closeSelf();
                        };
                    }
                    runtimePatchState.buildingBasePatched = true;
                    log("Patched BuildingBaseView.leaveBuilding & saveCommonCustomerDataList");
                }
            } catch (e) {}
        }

        // 9d. Patch GuideBookUtil.canGetGuideBookReward
        if (!runtimePatchState.guideBookPatched) {
            try {
                var gbMod = getModule("GuideBookUtil");
                var GBU = gbMod && gbMod.GuideBookUtil ? gbMod.GuideBookUtil : null;
                if (GBU && typeof GBU.canGetGuideBookReward === "function") {
                    var origCanGetGB = GBU.canGetGuideBookReward;
                    GBU.canGetGuideBookReward = function (taskId, bookId) {
                        try { return !!origCanGetGB.call(this, taskId, bookId); } catch (err) { return false; }
                    };
                    runtimePatchState.guideBookPatched = true;
                    log("Patched GuideBookUtil.canGetGuideBookReward");
                }
            } catch (e) {}
        }

        // 9e. Bug 4, 7.1, 7.3, 8 Fix: FguiSpine & SpineUtil local high-res PNG portrait fallback for remote Spines!
        if (!runtimePatchState.spineFallbackPatched) {
            try {
                var fgSpMod = getModule("FguiSpine");
                var spUtilMod = getModule("SpineUtil");
                var FguiSpineCls = fgSpMod && fgSpMod.FguiSpine ? fgSpMod.FguiSpine : null;
                var SpineUtilCls = spUtilMod && spUtilMod.SpineUtil ? spUtilMod.SpineUtil : null;

                if (FguiSpineCls && FguiSpineCls.prototype && SpineUtilCls) {
                    var removeOfflinePortrait = function (node) {
                        if (!node || !global.cc || !global.cc.isValid(node, true)) return;
                        try {
                            var oldP = node.getChildByName("__OfflinePortrait__");
                            if (oldP && global.cc.isValid(oldP, true)) {
                                oldP.removeFromParent();
                                oldP.destroy();
                            }
                        } catch (e) {}
                    };

                    var origClearSke = FguiSpineCls.prototype.clearSkeleton;
                    if (typeof origClearSke === "function") {
                        FguiSpineCls.prototype.clearSkeleton = function () {
                            removeOfflinePortrait(this.node);
                            return origClearSke.apply(this, arguments);
                        };
                    }

                    var origInitSke = FguiSpineCls.prototype.initSkeleton;
                    FguiSpineCls.prototype.initSkeleton = function (url, onLoaded, isJson, remotePkg, cacheMode, enableBatch) {
                        var localAct = resolveLocalActSpinePath(url, I18nUtil);
                        if (localAct) {
                            removeOfflinePortrait(this.node);
                            return origInitSke.call(this, localAct, onLoaded, isJson, "", cacheMode, enableBatch);
                        }
                        var pngPath = resolvePortraitFallbackPath(url, I18nUtil);
                        if (pngPath && I18nUtil && typeof I18nUtil.loadResWithType === "function" && global.cc && global.cc.Texture2D) {
                            var selfSp = this;
                            if (this.skeComp && this.node && global.sp && global.sp.Skeleton) {
                                try { this.node.removeComponent(global.sp.Skeleton); } catch (e) {}
                                this.skeComp = void 0;
                            }
                            this.skeUrl = url;
                            this.remotePackage = remotePkg || "";
                            this.isLoaded = false;
                            this.loadedCb = onLoaded;
                            I18nUtil.loadResWithType(pngPath, global.cc.Texture2D, function (err, tex) {
                                if (!err && tex && global.cc.isValid(selfSp.node, true) && selfSp.skeUrl === url) {
                                    attachPortraitSpriteToNode(selfSp.node, tex, 520);
                                    selfSp.isLoaded = true;
                                    if (typeof selfSp.loadedCb === "function") {
                                        try { selfSp.loadedCb(); } catch (cbErr) {}
                                    }
                                }
                            });
                            return;
                        }
                        removeOfflinePortrait(this.node);
                        return origInitSke.call(this, url, onLoaded, isJson, remotePkg, cacheMode, enableBatch);
                    };

                    var origLoadSpineRes = SpineUtilCls.loadSpineRes;
                    SpineUtilCls.loadSpineRes = function (viewCache, url, onSuccess, timeScale, onFail) {
                        var localAct = resolveLocalActSpinePath(url, I18nUtil);
                        if (localAct) {
                            return origLoadSpineRes.call(this, viewCache, localAct, onSuccess, timeScale, onFail);
                        }
                        var pngPath = resolvePortraitFallbackPath(url, I18nUtil);
                        if (pngPath && I18nUtil && typeof I18nUtil.loadResWithType === "function" && global.cc && global.cc.Texture2D) {
                            I18nUtil.loadResWithType(pngPath, global.cc.Texture2D, function (err, tex) {
                                if (!err && tex && global.cc) {
                                    var node = new global.cc.Node("skeleton");
                                    attachPortraitSpriteToNode(node, tex, 540);
                                    try { SpineUtilCls.setSkeUrl(node, url); } catch (e) {}
                                    if (typeof onSuccess === "function") {
                                        try { onSuccess(node); } catch (e2) {}
                                    }
                                } else if (typeof onFail === "function") {
                                    try { onFail(); } catch (e3) {}
                                }
                            });
                            return;
                        }
                        return origLoadSpineRes.call(this, viewCache, url, onSuccess, timeScale, onFail);
                    };

                    runtimePatchState.spineFallbackPatched = true;
                    log("Patched FguiSpine & SpineUtil with local high-res PNG portrait fallback");
                }
            } catch (e) {
                warn("Patch FguiSpine/SpineUtil failed:", e && e.message);
            }
        }

        // 9f. Bug 13 Fix: AudioMgr local bundled BGM & SFX playback!
        if (!runtimePatchState.audioPatched) {
            try {
                var audMod = getModule("AudioMgr");
                var AudioMgrCls = audMod && audMod.AudioMgr ? audMod.AudioMgr : null;
                if (AudioMgrCls && AudioMgrCls.prototype) {
                    var loadBundledClip = function (clipPath, done) {
                        if (I18nUtil && typeof I18nUtil.loadResWithType === "function" && global.cc && global.cc.AudioClip) {
                            I18nUtil.loadResWithType(clipPath, global.cc.AudioClip, function (err, clip) {
                                if (!err && clip) {
                                    done(clip);
                                } else if (global.cc && global.cc.resources) {
                                    global.cc.resources.load(clipPath, global.cc.AudioClip, function (e2, c2) {
                                        done(!e2 && c2 ? c2 : null);
                                    });
                                } else {
                                    done(null);
                                }
                            });
                            return;
                        }
                        if (global.cc && global.cc.resources && global.cc.AudioClip) {
                            global.cc.resources.load(clipPath, global.cc.AudioClip, function (err, clip) {
                                done(!err && clip ? clip : null);
                            });
                            return;
                        }
                        done(null);
                    };

                    var origAudLoad = AudioMgrCls.prototype.load;
                    AudioMgrCls.prototype.load = function (url, cb) {
                        var u = String(url || "");
                        var targetPath = u;
                        if (u.indexOf("common/sound/") >= 0 || !(I18nUtil && I18nUtil.isResValid && I18nUtil.isResValid(u))) {
                            targetPath = mapAudioToBundled(u);
                        }
                        loadBundledClip(targetPath, function (clip) {
                            if (clip) {
                                if (typeof cb === "function") cb(clip);
                            } else {
                                var fb = u.indexOf("bgm") >= 0 ? BUNDLED_BGMS[0] : BUNDLED_SFXS.click;
                                loadBundledClip(fb, function (clip2) {
                                    if (typeof cb === "function") cb(clip2 || null);
                                });
                            }
                        });
                    };
                    runtimePatchState.audioPatched = true;
                    log("Patched AudioMgr.load -> bundled local BGM & SFX MP3s");
                }
            } catch (e) {
                warn("Patch AudioMgr failed:", e && e.message);
            }
        }

        // 9g. Req #2 Fix: Enable Voucher / Thẻ Giảm Giá & Simulated Recharge on ALL paid packs!
        if (!runtimePatchState.rechargeConfigPatched) {
            try {
                var gcMod = getModule("GameConfig");
                if (gcMod && gcMod.GameConfig) {
                    gcMod.GameConfig.isForceSimulateRecharge = true;
                    gcMod.GameConfig.isSDKWithPlatform = false;
                    runtimePatchState.rechargeConfigPatched = true;
                    log("Enabled GameConfig.isForceSimulateRecharge = true (infinite Thẻ Giảm Giá / Voucher packs)");
                }
            } catch (e) {}
        }

        // 9h. Bug 7.1 Fix: ResetRoleMainView always allows choosing any starter role!
        if (!runtimePatchState.resetRolePatched) {
            try {
                var rrMod = getModule("ResetRoleMainView");
                var RRMV = rrMod && rrMod.ResetRoleMainView ? rrMod.ResetRoleMainView : null;
                if (RRMV && RRMV.prototype) {
                    RRMV.prototype.checkIsEffectiveTime = function () { return true; };
                    runtimePatchState.resetRolePatched = true;
                    log("Patched ResetRoleMainView.checkIsEffectiveTime -> always selectable");
                }
            } catch (e) {}
        }
    }

    // Install runtime patches as soon as Cocos script bundle finishes loading
    if (typeof global.jsb !== "undefined" || typeof global.__require === "function") {
        var patchTimerId = setInterval(function () {
            installRuntimePatches();
            if (runtimePatchState.remoteResPatched
                && runtimePatchState.uiMgrPatched
                && runtimePatchState.buildingBasePatched
                && runtimePatchState.guideBookPatched
                && runtimePatchState.spineFallbackPatched
                && runtimePatchState.audioPatched
                && runtimePatchState.rechargeConfigPatched
                && runtimePatchState.resetRolePatched
                && runtimePatchState.startPrivilegePatched) {
                clearInterval(patchTimerId);
                log("All Fix v4 runtime offline patches active.");
            }
        }, 250);
        if (patchTimerId && typeof patchTimerId.unref === "function") {
            patchTimerId.unref();
        }
    }

    // Export for Node.js E2E verification
    global.__GCXUA_OFFLINE_SERVER__ = {
        handleHttpRequest: handleHttpRequest,
        encodePacket: encodePacket,
        decodeClientPacket: decodeClientPacket,
        buildDefaultMessageObj: buildDefaultMessageObj,
        buildWorkshopConfig: buildWorkshopConfig,
        buildHeroAbilityList: buildHeroAbilityList,
        mapAudioToBundled: mapAudioToBundled,
        resolvePortraitFallbackPath: resolvePortraitFallbackPath,
        populateMaxTesterState: populateMaxTesterState,
        deliverShopPurchase: deliverShopPurchase,
        getState: getState,
        saveState: saveState,
        toRecvProtocol: toRecvProtocol,
        installRuntimePatches: installRuntimePatches,
        OfflineXMLHttpRequest: OfflineXMLHttpRequest,
        OfflineWebSocket: OfflineWebSocket
    };

    log("GocChoXua 3.7.1 Offline Server (Fix v4) initialized cleanly.");
})(typeof window !== "undefined" ? window : global);
