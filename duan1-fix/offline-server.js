(function () {
    "use strict";
    if (window.__hanhDaoKyOfflineInstalled) return;
    window.__hanhDaoKyOfflineInstalled = true;

    var SAVE_KEY = "hanhdaoky_offline_save_v1";
    var DEFAULT_UID = "offline_player";
    var DEFAULT_PLAYER_ID = 100001;
    var DEFAULT_SERVER_ID = 1;
    var DEFAULT_SERVER_NAME = "S1 - Hành Đạo Offline";

    var ROLE_TO_APPEARANCE = {
        1: 141001,
        2: 142001,
        3: 143001,
        4: 140401,
        5: 140501,
        6: 140601,
        7: 140701
    };

    function safeRequire(name) {
        try {
            if (typeof window.__require === "function") {
                return window.__require(name);
            }
        } catch (e) {
            console.warn("[Offline] require failed for " + name + ": " + e);
        }
        return null;
    }

    function getStorage() {
        try {
            if (typeof cc !== "undefined" && cc.sys && cc.sys.localStorage) {
                return cc.sys.localStorage;
            }
        } catch (e) {}
        if (typeof localStorage !== "undefined") return localStorage;
        return null;
    }

    function cloneObj(o) {
        return JSON.parse(JSON.stringify(o));
    }

    function makeDefaultState() {
        var now = Date.now();
        return {
            uid: DEFAULT_UID,
            playerId: DEFAULT_PLAYER_ID,
            nickName: "Đạo Hữu",
            roleId: 1,
            roleCreated: false,
            registerTime: now,
            lastLoginTime: now,
            realmsId: 1,
            exp: 0,
            dreamLv: 1,
            dreamLvUpEndTime: 0,
            equipIdSeq: 1000,
            equipmentList: [],
            unDealEquipments: [],
            bag: {
                "100000": 10000,  // XianYu (Tiên Ngọc)
                "100003": 50000,  // LingShi (Linh Thạch)
                "100004": 500,    // XianTao (Tiên Đào)
                "100009": 100,    // LingShouGuo
                "100010": 100,    // YuLingShi
                "100012": 5,      // GaiMingKa
                "100025": 50      // JingTan / stage reward item
            },
            passStageId: 0,
            tasks: {},
            currentMainTaskId: 100000,
            counters: {
                chop: 0,
                equip: 0,
                resolve: 0,
                resolveLingShi: 0,
                stageChallenge: 0
            },
            unlockedSystems: [1, 2, 3, 7, 10, 11, 12, 23, 28, 35, 36, 48],
            claimedSysRewards: [],
            cloud: {
                equipCloudId: 0,
                stage: 1,
                lv: 1,
                exp: 0
            },
            clientStorage: {}
        };
    }

    var state = makeDefaultState();

    function loadState() {
        try {
            var st = getStorage();
            if (!st) return;
            var raw = st.getItem(SAVE_KEY);
            if (!raw) return;
            var parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
                var def = makeDefaultState();
                for (var k in def) {
                    if (Object.prototype.hasOwnProperty.call(def, k) && parsed[k] === undefined) {
                        parsed[k] = def[k];
                    }
                }
                state = parsed;
            }
        } catch (e) {
            console.warn("[Offline] loadState error: " + e);
        }
    }

    function saveState() {
        try {
            var st = getStorage();
            if (st) {
                st.setItem(SAVE_KEY, JSON.stringify(state));
            }
        } catch (e) {
            console.warn("[Offline] saveState error: " + e);
        }
    }

    loadState();

    // BigInt-free decimal bitmask builder (works on any JS engine / V8 / SpiderMonkey)
    function addDecimalStrings(a, b) {
        var i = a.length - 1, j = b.length - 1, carry = 0, out = [];
        while (i >= 0 || j >= 0 || carry > 0) {
            var da = i >= 0 ? (a.charCodeAt(i--) - 48) : 0;
            var db = j >= 0 ? (b.charCodeAt(j--) - 48) : 0;
            var s = da + db + carry;
            out.push(String.fromCharCode(48 + (s % 10)));
            carry = (s / 10) | 0;
        }
        return out.reverse().join("");
    }

    function pow2Decimal(n) {
        var res = "1";
        for (var i = 0; i < n; i++) {
            res = addDecimalStrings(res, res);
        }
        return res;
    }

    function bitmaskDecimalFromIds(idList) {
        var seen = {};
        var total = "0";
        for (var i = 0; i < idList.length; i++) {
            var id = Number(idList[i]);
            if (id >= 0 && id < 256 && !seen[id]) {
                seen[id] = true;
                total = addDecimalStrings(total, pow2Decimal(id));
            }
        }
        return total;
    }

    function getDB() {
        var m = safeRequire("DBMgr");
        return m ? m.DBMgr : null;
    }

    function getProtocol() {
        var m = safeRequire("Protocol");
        return m ? m.Protocol : null;
    }

    function getProtobufMgr() {
        var m = safeRequire("ProtobufMgr");
        return m ? m.ProtobufMgr.inst : null;
    }

    function getGameNetMgr() {
        var m = safeRequire("GameNetMgr");
        return m ? m.GameNetMgr.inst : null;
    }

    function getAppearanceId() {
        return ROLE_TO_APPEARANCE[state.roleId] || 141001;
    }

    function addBagItem(propId, delta) {
        var key = String(propId);
        var cur = Number(state.bag[key] || 0);
        var next = cur + Number(delta || 0);
        if (next < 0) next = 0;
        state.bag[key] = next;
        return next;
    }

    function getBagItem(propId) {
        return Number(state.bag[String(propId)] || 0);
    }

    function grantRewardString(rewardStr) {
        if (!rewardStr || rewardStr === "0") return [];
        var changed = [];
        var parts = String(rewardStr).split("|");
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            if (!p) continue;
            var kv = p.split("=");
            if (kv.length >= 2) {
                var id = Number(kv[0]);
                var num = Number(kv[1]);
                if (!isNaN(id) && !isNaN(num) && num > 0) {
                    addBagItem(id, num);
                    changed.push({ propId: id, num: String(getBagItem(id)) });
                }
            }
        }
        return changed;
    }

    function parseCostString(costStr) {
        var list = [];
        if (!costStr || costStr === "0") return list;
        var parts = String(costStr).split("|");
        for (var i = 0; i < parts.length; i++) {
            var kv = parts[i].split("=");
            if (kv.length >= 2) {
                var id = Number(kv[0]);
                var num = Number(kv[1]);
                if (!isNaN(id) && !isNaN(num) && num > 0) {
                    list.push({ propId: id, num: num });
                }
            }
        }
        return list;
    }

    function buildBagSyncData(propIds) {
        var arr = [];
        if (propIds && propIds.length) {
            for (var i = 0; i < propIds.length; i++) {
                var id = Number(propIds[i]);
                arr.push({ propId: id, num: String(getBagItem(id)) });
            }
        } else {
            for (var k in state.bag) {
                if (Object.prototype.hasOwnProperty.call(state.bag, k)) {
                    arr.push({ propId: Number(k), num: String(state.bag[k]) });
                }
            }
        }
        return { bagData: arr };
    }

    function getRealmsCfg(id) {
        var DBMgr = getDB();
        if (DBMgr && DBMgr.RealmsDB && DBMgr.RealmsDB[id]) {
            return DBMgr.RealmsDB[id];
        }
        return {
            id: id,
            demonicMax: String(100 * id * id),
            demonicEachDream: String(15 * id),
            attackBase: String(15 + id * 12),
            hpBase: String(100 + id * 80),
            attackDef: String(3 + id * 3),
            speedBase: String(100 + id * 5)
        };
    }

    function computeAttributes(equipList) {
        var cfg = getRealmsCfg(state.realmsId);
        var map = {
            1: Number(cfg.attackBase || 15),   // Attack
            2: Number(cfg.hpBase || 100),      // HP
            3: Number(cfg.attackDef || 3),     // Defense
            4: Number(cfg.speedBase || 100),   // Speed
            5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0,
            11: 0, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0
        };
        var list = equipList || state.equipmentList || [];
        for (var i = 0; i < list.length; i++) {
            var eq = list[i];
            if (!eq || !eq.attributeList) continue;
            for (var j = 0; j < eq.attributeList.length; j++) {
                var a = eq.attributeList[j];
                map[a.type] = (map[a.type] || 0) + Number(a.value || 0);
            }
        }
        var attrs = [];
        for (var t = 1; t <= 16; t++) {
            if (t <= 4 || map[t] > 0) {
                attrs.push({ type: t, value: String(Math.floor(map[t])) });
            }
        }
        var secSum = 0;
        for (var s = 5; s <= 16; s++) secSum += (map[s] || 0);
        var fightVal = Math.floor(map[1] * 10 + map[2] * 2 + map[3] * 8 + map[4] * 5 + secSum * 2);
        return {
            attrs: attrs,
            map: map,
            fightValue: String(Math.max(100, fightVal))
        };
    }

    function getEquipmentSlot(equipmentId) {
        var DBMgr = getDB();
        if (DBMgr && DBMgr.EquipmentDB && DBMgr.EquipmentDB[equipmentId]) {
            return Number(DBMgr.EquipmentDB[equipmentId].type || 1);
        }
        return ((Math.floor((equipmentId - 10001) / 100)) % 12) + 1;
    }

    function pickEquipmentId(slot, quality) {
        var DBMgr = getDB();
        if (DBMgr && DBMgr.EquipmentDB) {
            var exact = null;
            var best = null;
            var bestQ = 0;
            for (var id in DBMgr.EquipmentDB) {
                if (!Object.prototype.hasOwnProperty.call(DBMgr.EquipmentDB, id)) continue;
                var row = DBMgr.EquipmentDB[id];
                if (Number(row.type) !== slot) continue;
                var rq = Number(row.quality || 1);
                if (rq === quality) {
                    exact = Number(row.id);
                    break;
                }
                if (rq <= quality && rq >= bestQ) {
                    bestQ = rq;
                    best = Number(row.id);
                }
                if (!best) best = Number(row.id);
            }
            if (exact) return exact;
            if (best) return best;
        }
        return 10000 + (slot - 1) * 100 + Math.max(1, Math.min(9, quality));
    }

    function rollDreamQuality() {
        var DBMgr = getDB();
        var weights = [6900, 2000, 1000, 100];
        if (DBMgr && DBMgr.EquipmentCreateDB && DBMgr.EquipmentCreateDB[state.dreamLv]) {
            var qStr = DBMgr.EquipmentCreateDB[state.dreamLv].quality;
            if (qStr) {
                weights = String(qStr).split("|").map(function (x) { return Number(x) || 0; });
            }
        }
        var total = 0;
        for (var i = 0; i < weights.length; i++) total += weights[i];
        if (total <= 0) return 1;
        var r = Math.random() * total;
        var acc = 0;
        for (var j = 0; j < weights.length; j++) {
            acc += weights[j];
            if (r < acc) return j + 1;
        }
        return 1;
    }

    function generateEquipment() {
        var slot = 1 + Math.floor(Math.random() * 12);
        var quality = rollDreamQuality();
        var level = Math.max(1, state.realmsId + Math.floor(Math.random() * 3) - 1);
        var equipmentId = pickEquipmentId(slot, quality);
        var scale = Math.pow(1.18, Math.min(level - 1, 80)) * (1 + (quality - 1) * 0.45);
        var randFactor = function () { return 0.9 + Math.random() * 0.25; };

        var atk = Math.max(5, Math.floor(12 * scale * randFactor()));
        var hp = Math.max(30, Math.floor(75 * scale * randFactor()));
        var def = Math.max(2, Math.floor(4 * scale * randFactor()));
        var spd = Math.max(5, Math.floor((8 + level * 1.5 + quality * 3) * randFactor()));

        var attrList = [
            { type: 1, value: String(atk) },
            { type: 2, value: String(hp) },
            { type: 3, value: String(def) },
            { type: 4, value: String(spd) }
        ];
        if (quality >= 2) {
            var secType = 5 + Math.floor(Math.random() * 6); // 5..10
            var secVal = Math.floor((150 + quality * 120) * randFactor());
            attrList.push({ type: secType, value: String(secVal) });
        }
        if (quality >= 4) {
            var resType = 11 + Math.floor(Math.random() * 6); // 11..16
            var resVal = Math.floor((120 + quality * 100) * randFactor());
            attrList.push({ type: resType, value: String(resVal) });
        }

        state.equipIdSeq = (state.equipIdSeq || 1000) + 1;
        var eqData = {
            id: state.equipIdSeq,
            equipmentId: equipmentId,
            level: level,
            quality: quality,
            attributeList: attrList,
            src: 0
        };

        // Preview attributes if equipped in its slot
        var previewList = [];
        var replaced = false;
        for (var i = 0; i < state.equipmentList.length; i++) {
            var cur = state.equipmentList[i];
            if (getEquipmentSlot(cur.equipmentId) === slot) {
                previewList.push(eqData);
                replaced = true;
            } else {
                previewList.push(cur);
            }
        }
        if (!replaced) previewList.push(eqData);
        var previewStats = computeAttributes(previewList);

        return {
            unDealEquipmentData: eqData,
            playerAttributeDataList: previewStats.attrs,
            fightValue: previewStats.fightValue,
            unDealEquipmentAttrList: []
        };
    }

    function buildPlayerAttributeDataMsg() {
        var stats = computeAttributes(state.equipmentList);
        return {
            realmsId: state.realmsId,
            exp: String(state.exp),
            fightValue: stats.fightValue,
            playerAttributeDataList: stats.attrs,
            equipmentList: cloneObj(state.equipmentList),
            useSeparationIdx: 0,
            soaringState: 0,
            resetSoaringTimes: 0,
            todaySoaringTimes: 0
        };
    }

    function buildDreamDataMsg() {
        // Check if tree upgrade timer already finished
        if (state.dreamLvUpEndTime > 0 && Date.now() >= state.dreamLvUpEndTime) {
            state.dreamLv += 1;
            state.dreamLvUpEndTime = 0;
        }
        return {
            dreamLv: state.dreamLv,
            unDealEquipmentDataMsg: cloneObj(state.unDealEquipments || []),
            dreamLvUpEndTime: state.dreamLvUpEndTime || 0,
            freeSpeedUpCdEndTime: 0,
            freeSpeedUpTimes: 0,
            dailyGoldenPeachCost: 0
        };
    }

    function buildPlayerCharaDataMsg() {
        var appId = getAppearanceId();
        return {
            equipHeadIcon: appId,
            equipAppearanceId: appId,
            haveSpecialChara: [{ charaId: appId, expireTime: 0, lv: 1 }],
            titleId: 0,
            equipHeadIconFrame: 0,
            equipChatBubble: 0,
            equipAtkEffect: 0,
            medalId: 0,
            appearanceCollect: [],
            equipSceneId: 0,
            equipFrogId: 0,
            equipArtifactId: 0,
            realTitleId: 0
        };
    }

    function buildSystemUnlockSync() {
        // Dynamically ensure systems unlocked by realmsId/passStageId
        var DBMgr = getDB();
        if (DBMgr && DBMgr.SystemInfoDB) {
            for (var k in DBMgr.SystemInfoDB) {
                if (!Object.prototype.hasOwnProperty.call(DBMgr.SystemInfoDB, k)) continue;
                var sysId = Number(k);
                if (sysId <= 0 || sysId > 160) continue;
                if (state.unlockedSystems.indexOf(sysId) >= 0) continue;
                var row = DBMgr.SystemInfoDB[k];
                var condTypes = String(row.conditionType || "1").split("|");
                var vals = String(row.value || "0").split("|");
                var ok = true;
                for (var i = 0; i < condTypes.length; i++) {
                    var ct = Number(condTypes[i]);
                    var v = Number(vals[i] || 0);
                    if (ct === 1 && state.realmsId < v) ok = false;
                    else if (ct === 2 && state.passStageId < v) ok = false;
                    else if (ct === 3 && state.currentMainTaskId < v) ok = false;
                }
                if (ok) state.unlockedSystems.push(sysId);
            }
        }
        return {
            unlockInfo: bitmaskDecimalFromIds(state.unlockedSystems),
            getRewardInfo: bitmaskDecimalFromIds(state.claimedSysRewards)
        };
    }

    function computeTaskValue(taskCfg) {
        if (!taskCfg) return 0;
        var ct = Number(taskCfg.completeType);
        var params = String(taskCfg.completeParams || "0").split("|").map(function (x) { return Number(x) || 0; });
        switch (ct) {
            case 1:
            case 2:
                return state.counters.chop || 0;
            case 3:
                return state.passStageId || 0;
            case 21:
                return state.realmsId || 1;
            case 44:
                return state.equipmentList.length;
            case 45:
                return state.counters.resolveLingShi || 0;
            case 51:
                return state.counters.stageChallenge || 0;
            case 70: {
                var minQ = params[0] || 1;
                var cnt = 0;
                for (var i = 0; i < state.equipmentList.length; i++) {
                    if (Number(state.equipmentList[i].quality || 1) >= minQ) cnt++;
                }
                return cnt;
            }
            case 71:
                return state.counters.resolve || 0;
            default:
                // For advanced/unknown task types, allow claiming smoothly so main quest never blocks
                return Math.max(1, params[0] || 1);
        }
    }

    function ensureMainTask() {
        var DBMgr = getDB();
        var tid = state.currentMainTaskId || 100000;
        if (!state.tasks[tid]) {
            state.tasks[tid] = { taskId: tid, value: "0", state: 0 };
        }
        if (DBMgr && DBMgr.GameTaskDB && DBMgr.GameTaskDB[tid]) {
            state.tasks[tid].value = String(computeTaskValue(DBMgr.GameTaskDB[tid]));
        }
        return state.tasks[tid];
    }

    function buildTaskListMsg(onlyCurrent) {
        var cur = ensureMainTask();
        var list = [];
        if (onlyCurrent) {
            list.push({
                taskId: cur.taskId,
                value: String(cur.value),
                state: cur.state,
                multiReward: [],
                selectItem: []
            });
        } else {
            for (var k in state.tasks) {
                if (!Object.prototype.hasOwnProperty.call(state.tasks, k)) continue;
                var t = state.tasks[k];
                list.push({
                    taskId: t.taskId,
                    value: String(t.value),
                    state: t.state,
                    multiReward: [],
                    selectItem: []
                });
            }
        }
        return { dataList: list };
    }

    function getNextStageInfo() {
        var DBMgr = getDB();
        var nextId = (state.passStageId || 0) + 1;
        var stageCfg = (DBMgr && DBMgr.GameStageDB && DBMgr.GameStageDB[nextId]) || null;
        if (!stageCfg) {
            return {
                stageId: nextId,
                monsterId: 100001,
                monsterLevel: nextId,
                atk: 15 * nextId,
                hp: 120 * nextId,
                def: 4 * nextId,
                spd: 90 + nextId * 2,
                rewards: "100004=5|100000=20"
            };
        }
        var mId = Number(stageCfg.mosterList || 100001);
        var mLv = Number(stageCfg.mosterLevelList || nextId);
        var mCfg = (DBMgr.MonstersDB && DBMgr.MonstersDB[mId]) || {};
        var lvCfg = (DBMgr.MonstersLevelDB && DBMgr.MonstersLevelDB[mLv]) || {};
        var atk = Math.max(10, Math.floor((Number(lvCfg.attackBase || 50) * Number(mCfg.attackEmp || 1000)) / 1000));
        var hp = Math.max(50, Math.floor((Number(lvCfg.hpBase || 300) * Number(mCfg.hpEmp || 1000)) / 1000));
        var def = Math.max(2, Math.floor((Number(lvCfg.defBase || 10) * Number(mCfg.defEmp || 1000)) / 1000));
        var spd = Math.max(50, Math.floor((Number(lvCfg.speedBase || 100) * Number(mCfg.speedEmp || 1000)) / 1000));
        return {
            stageId: nextId,
            monsterId: mId,
            monsterLevel: mLv,
            atk: atk,
            hp: hp,
            def: def,
            spd: spd,
            rewards: stageCfg.rewards || "100004=5"
        };
    }

    function buildStageDataMsg() {
        var info = getNextStageInfo();
        var mFight = Math.floor(info.atk * 10 + info.hp * 2 + info.def * 8 + info.spd * 5);
        return {
            passStageId: state.passStageId || 0,
            monsterFightVal: String(mFight)
        };
    }

    function simulateStageBattle(stageInfo) {
        var pb = getProtobufMgr();
        var pStats = computeAttributes(state.equipmentList);
        var pAtk = Math.max(10, pStats.map[1] || 20);
        var pMaxHp = Math.max(100, pStats.map[2] || 150);
        var pDef = Math.max(1, pStats.map[3] || 5);
        var pSpd = Math.max(50, pStats.map[4] || 100);
        var pCrit = Math.min(0.6, (pStats.map[6] || 0) / 10000 + 0.1);

        var mAtk = stageInfo.atk;
        var mMaxHp = stageInfo.hp;
        var mDef = stageInfo.def;
        var mSpd = stageInfo.spd;

        var pHp = pMaxHp;
        var mHp = mMaxHp;
        var rounds = [];
        var maxRounds = 15;

        function encodeMainAction(actObj) {
            if (pb && typeof pb.encodeMsg === "function") {
                var bytes = pb.encodeMsg("MainAction", actObj);
                if (bytes) return bytes;
            }
            return new Uint8Array(0);
        }

        for (var r = 1; r <= maxRounds && pHp > 0 && mHp > 0; r++) {
            var actions = [];
            var order = pSpd >= mSpd ? [1, 2] : [2, 1];
            for (var k = 0; k < order.length; k++) {
                if (pHp <= 0 || mHp <= 0) break;
                var attacker = order[k];
                var target = attacker === 1 ? 2 : 1;
                var isCrit = attacker === 1 ? (Math.random() < pCrit) : (Math.random() < 0.08);
                var rawDmg = attacker === 1
                    ? Math.max(Math.ceil(pAtk * 0.2), pAtk - Math.floor(mDef * 0.5))
                    : Math.max(Math.ceil(mAtk * 0.15), mAtk - Math.floor(pDef * 0.5));
                if (isCrit) rawDmg = Math.floor(rawDmg * 1.5);
                rawDmg = Math.max(1, rawDmg);

                if (attacker === 1) {
                    mHp = Math.max(0, mHp - rawDmg);
                } else {
                    pHp = Math.max(0, pHp - rawDmg);
                }

                var mainAct = {
                    objId: attacker,
                    isAttackBackAction: false,
                    mainAttackResult: [{
                        isHit: true,
                        isCritical: isCrit,
                        isMagic: false,
                        damage: [String(rawDmg)],
                        lifeSteal: "0",
                        stunRound: 0
                    }],
                    removeStun: false,
                    targetId: target
                };
                actions.push({
                    objType: 1,
                    action: encodeMainAction(mainAct)
                });
            }
            rounds.push({
                round: r,
                action: actions,
                battleMainState: [
                    { objId: 1, hp: String(pHp), energy: 0, maxHp: String(pMaxHp), shieldVal: "0" },
                    { objId: 2, hp: String(mHp), energy: 0, maxHp: String(mMaxHp), shieldVal: "0" }
                ],
                universeValue: []
            });
        }

        var isWin = mHp <= 0;
        var mAttrs = [
            { type: 1, value: String(mAtk) },
            { type: 2, value: String(mMaxHp) },
            { type: 3, value: String(mDef) },
            { type: 4, value: String(mSpd) }
        ];

        return {
            battleMain: [
                {
                    objId: 1,
                    battleModel: { type: 1, mainRoleId: getAppearanceId(), realmsId: state.realmsId },
                    maxHp: String(pMaxHp),
                    maxEnergy: 100,
                    initShieldVal: "0",
                    curHp: String(pMaxHp),
                    pos: 0,
                    name: state.nickName,
                    playerId: state.playerId,
                    attr: pStats.attrs
                },
                {
                    objId: 2,
                    battleModel: { type: 2, mainRoleId: stageInfo.monsterId, realmsId: stageInfo.monsterLevel },
                    maxHp: String(mMaxHp),
                    maxEnergy: 100,
                    initShieldVal: "0",
                    curHp: String(mMaxHp),
                    pos: 1,
                    name: "Yêu Quái",
                    playerId: 0,
                    attr: mAttrs
                }
            ],
            battleRoundLog: rounds,
            isWin: isWin,
            maxRoundLimit: maxRounds
        };
    }

    // Build a valid default object for any Protobuf message class (used by catch-all fallback)
    function buildDefaultProtoObj(MsgClass, depth) {
        if (!MsgClass || (depth || 0) > 4) return {};
        var obj = {};
        try {
            var meta = MsgClass.$type;
            if (meta && meta._fields) {
                for (var i = 0; i < meta._fields.length; i++) {
                    var f = meta._fields[i];
                    if (f.name === "ret") {
                        obj.ret = 0;
                        continue;
                    }
                    if (!f.required && !f.repeated) continue;
                    if (f.repeated) {
                        obj[f.name] = [];
                        continue;
                    }
                    var tName = f.type ? f.type.name : "";
                    if (tName === "string") obj[f.name] = "";
                    else if (tName === "bool") obj[f.name] = false;
                    else if (tName === "bytes") obj[f.name] = new Uint8Array(0);
                    else if (tName === "message" && f.resolvedType && f.resolvedType.clazz) {
                        obj[f.name] = buildDefaultProtoObj(f.resolvedType.clazz, (depth || 0) + 1);
                    } else {
                        obj[f.name] = 0;
                    }
                }
            }
        } catch (e) {}
        return obj;
    }

    function pushPb(protoId, dataObj) {
        var Protocol = getProtocol();
        var ProtobufMgr = getProtobufMgr();
        var GameNetMgr = getGameNetMgr();
        if (!Protocol || !ProtobufMgr || !GameNetMgr) return;

        var smId = Protocol.getProtocalIdRemainder(protoId);
        var MsgClass = ProtobufMgr.getMsg(smId, false, true);
        var decoded = dataObj;

        if (MsgClass) {
            try {
                var inst = new MsgClass(dataObj || {});
                var ab = inst.encode().toArrayBuffer();
                decoded = MsgClass.decode(new Uint8Array(ab));
            } catch (e) {
                console.warn("[Offline] Protobuf roundtrip warn protoId=" + protoId + " smId=" + smId + ": " + e);
                try {
                    var filled = buildDefaultProtoObj(MsgClass, 0);
                    if (dataObj) {
                        for (var k in dataObj) {
                            if (Object.prototype.hasOwnProperty.call(dataObj, k)) filled[k] = dataObj[k];
                        }
                    }
                    var inst2 = new MsgClass(filled);
                    decoded = MsgClass.decode(new Uint8Array(inst2.encode().toArrayBuffer()));
                } catch (e2) {
                    decoded = dataObj || { ret: 0 };
                }
            }
        }
        GameNetMgr.resvHandler(smId, decoded);
    }

    function handlePbRequest(msgId, pbMsg) {
        var Protocol = getProtocol();
        var ProtobufMgr = getProtobufMgr();
        if (!Protocol) return;

        var now = Date.now();
        console.log("[Offline] PB Req msgId=" + msgId);

        // 1. Login
        if (msgId === Protocol.S_PLAYER_LOGIN) {
            state.lastLoginTime = now;
            saveState();

            pushPb(Protocol.S_PLAYER_LOGIN, {
                ret: 0,
                timeData: { timestamp: now, timeZone: 7 }
            });

            // Sync required + helpful initial game data
            setTimeout(function () {
                pushPb(Protocol.S_PLAYER_DATA_SYNC_MSG, {
                    playerId: state.playerId,
                    nickName: state.nickName,
                    roleId: state.roleId,
                    serverId: DEFAULT_SERVER_ID,
                    lastLoginTime: state.lastLoginTime,
                    playerBelong: "",
                    hideAddress: 0,
                    unionId: 0,
                    myInviteCode: "OFFLINE",
                    wxHeadUrl: "",
                    changeNameTimes: 0,
                    enterType: 0,
                    registerTime: state.registerTime,
                    isSubscribeMail: 0,
                    changeNums: 0,
                    startTime: state.registerTime
                });
                pushPb(Protocol.S_PLAYER_CHARA_DATA_SYNC, buildPlayerCharaDataMsg());
                pushPb(Protocol.S_ATTRIBUTE_DATA_SYNC_MSG, buildPlayerAttributeDataMsg());
                pushPb(Protocol.S_DREAM_DATA_SYNC, buildDreamDataMsg());
                pushPb(Protocol.S_SYSTEM_UNLOCK_SYNC_MSG, buildSystemUnlockSync());
                pushPb(Protocol.S_BAG_DATA_SYNC_MSG, buildBagSyncData());
                pushPb(Protocol.S_STAGE_DATA_SYNC, buildStageDataMsg());
                pushPb(Protocol.S_TASK_DATA_SEND, buildTaskListMsg(false));

                // Optional secondary subsystem syncs so UI tabs render cleanly
                if (Protocol.S_MAIL_LIST) pushPb(Protocol.S_MAIL_LIST, { mailList: [] });
                if (Protocol.S_MALL_BUY_COUNT_SYNC) pushPb(Protocol.S_MALL_BUY_COUNT_SYNC, { mallBuyCountList: [] });
                if (Protocol.S_CLOUD_PLAYER_DATA_SYNC) {
                    pushPb(Protocol.S_CLOUD_PLAYER_DATA_SYNC, {
                        equipCloudId: state.cloud.equipCloudId || 0,
                        cloudDataMsg: [],
                        stage: state.cloud.stage || 1,
                        lv: state.cloud.lv || 1,
                        exp: state.cloud.exp || 0,
                        cloudSkinDataMsg: [],
                        equipCloudSkinId: 0
                    });
                }
                if (Protocol.S_PET_DATA_SYNC) {
                    pushPb(Protocol.S_PET_DATA_SYNC, {
                        playerPetData: {
                            petPoolData: [],
                            petBagCount: 10,
                            petData: [],
                            equipPetId: 0,
                            refreshTimes: 0,
                            collectPetId: [],
                            freeRefreshTimes: 5,
                            privilegeTimes: 0,
                            wishPetId: 0,
                            wishPetProgress: 0
                        }
                    });
                }
                if (Protocol.S_SPIRIT_SYNC_DATA) {
                    pushPb(Protocol.S_SPIRIT_SYNC_DATA, {
                        spiritData: [],
                        spiritBattleTeamMsg: [],
                        battleTeamNo: 1,
                        drawTimes: 0,
                        protectTimes: 0,
                        spiritCombineMsg: [],
                        drawTimesTotal: 0
                    });
                }
                if (Protocol.S_TALENT_SYNC_DATA) {
                    pushPb(Protocol.S_TALENT_SYNC_DATA, {
                        talentData: [],
                        talentCreateLevel: 1,
                        exp: 0,
                        unDealTalentData: [],
                        readBookTimes: 0
                    });
                }

                // Finish login sync -> triggers MainView!
                pushPb(Protocol.S_LOGIN_SYNC_OVER, {});
            }, 30);
            return;
        }

        // 2. Ping
        if (msgId === Protocol.S_PLAYER_PING) {
            pushPb(Protocol.S_PLAYER_PING, {
                timeData: { timestamp: now, timeZone: 7 }
            });
            return;
        }

        // 3. Chop tree (Dream)
        if (msgId === Protocol.S_ATTRIBUTE_DREAM_MSG) {
            var times = Math.max(1, Math.min(10, Number((pbMsg && pbMsg.times) || 1)));
            // Keep offline play enjoyable: if peach count < times, auto-refill
            if (getBagItem(100004) < times) {
                addBagItem(100004, 200);
            }
            addBagItem(100004, -times);

            var drops = [];
            for (var i = 0; i < times; i++) {
                var unDeal = generateEquipment();
                state.unDealEquipments.push(unDeal);
                drops.push({
                    reward: "",
                    equipment: unDeal
                });
            }
            state.counters.chop = (state.counters.chop || 0) + times;
            saveState();

            pushPb(Protocol.S_BAG_DATA_SYNC_MSG, buildBagSyncData([100004]));
            pushPb(Protocol.S_TASK_DATA_SYNC, buildTaskListMsg(true));
            pushPb(Protocol.S_ATTRIBUTE_DREAM_MSG, {
                ret: 0,
                dropReward: drops,
                playerAttributeDataMsg: buildPlayerAttributeDataMsg(),
                dreamItemCostTotalNum: times
            });
            return;
        }

        // 4. Deal Equipment (0=Equip, 1=Resolve, 2=EquipAndResolveOld)
        if (msgId === Protocol.S_ATTRIBUTE_EQUIPMENT_DEAL_MSG) {
            var dealType = Number((pbMsg && pbMsg.type) || 0);
            var idList = (pbMsg && pbMsg.idList) ? pbMsg.idList.map(function (x) { return Number(x); }) : [];
            if (idList.length === 0 && state.unDealEquipments.length > 0) {
                idList = [Number(state.unDealEquipments[0].unDealEquipmentData.id)];
            }

            var totalExp = 0;
            var totalLingShi = 0;
            var realmsCfg = getRealmsCfg(state.realmsId);
            var baseExp = Number(realmsCfg.demonicEachDream || 10);

            for (var j = 0; j < idList.length; j++) {
                var targetId = idList[j];
                var idx = -1;
                for (var u = 0; u < state.unDealEquipments.length; u++) {
                    if (Number(state.unDealEquipments[u].unDealEquipmentData.id) === targetId) {
                        idx = u;
                        break;
                    }
                }
                if (idx < 0) continue;
                var itemWrap = state.unDealEquipments.splice(idx, 1)[0];
                var eq = itemWrap.unDealEquipmentData;

                if (dealType === 1) {
                    // Resolve
                    var gExp = Math.max(10, Math.floor(baseExp * (1 + (eq.quality - 1) * 0.5)));
                    var gLS = Math.max(10, Math.floor(eq.level * eq.quality * 15));
                    totalExp += gExp;
                    totalLingShi += gLS;
                    state.counters.resolve = (state.counters.resolve || 0) + 1;
                    state.counters.resolveLingShi = (state.counters.resolveLingShi || 0) + gLS;
                } else {
                    // Equip (0) or EquipAndResolveOld (2)
                    var slot = getEquipmentSlot(eq.equipmentId);
                    var oldIdx = -1;
                    for (var eIdx = 0; eIdx < state.equipmentList.length; eIdx++) {
                        if (getEquipmentSlot(state.equipmentList[eIdx].equipmentId) === slot) {
                            oldIdx = eIdx;
                            break;
                        }
                    }
                    var oldEq = null;
                    if (oldIdx >= 0) {
                        oldEq = state.equipmentList[oldIdx];
                        state.equipmentList[oldIdx] = eq;
                    } else {
                        state.equipmentList.push(eq);
                    }
                    state.counters.equip = (state.counters.equip || 0) + 1;

                    if (oldEq) {
                        if (dealType === 2) {
                            var oExp = Math.max(10, Math.floor(baseExp * (1 + (oldEq.quality - 1) * 0.5)));
                            var oLS = Math.max(10, Math.floor(oldEq.level * oldEq.quality * 15));
                            totalExp += oExp;
                            totalLingShi += oLS;
                            state.counters.resolve = (state.counters.resolve || 0) + 1;
                            state.counters.resolveLingShi = (state.counters.resolveLingShi || 0) + oLS;
                        } else {
                            var pStats = computeAttributes(state.equipmentList);
                            state.unDealEquipments.unshift({
                                unDealEquipmentData: oldEq,
                                playerAttributeDataList: pStats.attrs,
                                fightValue: pStats.fightValue,
                                unDealEquipmentAttrList: []
                            });
                        }
                    }
                }
            }

            if (totalExp > 0) state.exp = Number(state.exp || 0) + totalExp;
            var rewardStr = "";
            if (totalLingShi > 0) {
                addBagItem(100003, totalLingShi);
                rewardStr = "100003=" + totalLingShi;
            }
            saveState();

            if (totalLingShi > 0) {
                pushPb(Protocol.S_BAG_DATA_SYNC_MSG, buildBagSyncData([100003]));
            }
            pushPb(Protocol.S_TASK_DATA_SYNC, buildTaskListMsg(true));
            pushPb(Protocol.S_ATTRIBUTE_EQUIPMENT_DEAL_MSG, {
                ret: 0,
                reward: rewardStr,
                playerAttributeDataMsg: buildPlayerAttributeDataMsg(),
                dreamDataMsg: buildDreamDataMsg(),
                exp: totalExp,
                liquidAddExp: 0,
                godBodyAloneDataMsgList: []
            });
            return;
        }

        // 5. Get Undeal Equipments
        if (msgId === Protocol.S_ATTRIBUTE_GET_UNDEAL_EQUIPMENT_MSG) {
            pushPb(Protocol.S_ATTRIBUTE_GET_UNDEAL_EQUIPMENT_MSG, {
                ret: 0,
                undDealEquipmentDataMsg: cloneObj(state.unDealEquipments || [])
            });
            return;
        }

        // 6. Realm Level Up (Đột Phá Cảnh Giới)
        if (msgId === Protocol.S_ATTRIBUTE_REALMS_LEVE_UP_MSG) {
            var curCfg = getRealmsCfg(state.realmsId);
            var needExp = Number(curCfg.demonicMax || 100);
            state.exp = Math.max(0, Number(state.exp || 0) - needExp);
            state.realmsId = (state.realmsId || 1) + 1;
            saveState();

            pushPb(Protocol.S_SYSTEM_UNLOCK_SYNC_MSG, buildSystemUnlockSync());
            pushPb(Protocol.S_TASK_DATA_SYNC, buildTaskListMsg(true));
            pushPb(Protocol.S_ATTRIBUTE_REALMS_LEVE_UP_MSG, {
                ret: 0,
                isSuccess: true,
                playerAttributeDataMsg: buildPlayerAttributeDataMsg(),
                playerCharaDataMsg: buildPlayerCharaDataMsg()
            });
            return;
        }

        // 7. Tribulation Success Probability
        if (msgId === Protocol.S_ATTRIBUTE_GET_TRIBULATION_SUCCESS_PRO) {
            pushPb(Protocol.S_ATTRIBUTE_GET_TRIBULATION_SUCCESS_PRO, {
                ret: 0,
                probability: 10000
            });
            return;
        }

        // 8. Tree Level Up
        if (msgId === Protocol.S_ATTRIBUTE_DREAM_LV_UP) {
            var DBMgr = getDB();
            var createCfg = DBMgr && DBMgr.EquipmentCreateDB && DBMgr.EquipmentCreateDB[state.dreamLv];
            var costs = createCfg ? parseCostString(createCfg.cost) : [{ propId: 100003, num: 150 }];
            var changedIds = [];
            for (var ci = 0; ci < costs.length; ci++) {
                if (getBagItem(costs[ci].propId) < costs[ci].num) {
                    pushPb(Protocol.S_ATTRIBUTE_DREAM_LV_UP, { ret: 1001, dreamDataMsg: buildDreamDataMsg() });
                    return;
                }
            }
            for (var cj = 0; cj < costs.length; cj++) {
                addBagItem(costs[cj].propId, -costs[cj].num);
                changedIds.push(costs[cj].propId);
            }
            // Upgrade immediately in offline mode for great UX
            state.dreamLv += 1;
            state.dreamLvUpEndTime = 0;
            if (createCfg && createCfg.reward && createCfg.reward !== "0") {
                grantRewardString(createCfg.reward);
            }
            saveState();
            if (changedIds.length) pushPb(Protocol.S_BAG_DATA_SYNC_MSG, buildBagSyncData());
            pushPb(Protocol.S_ATTRIBUTE_DREAM_LV_UP, {
                ret: 0,
                dreamDataMsg: buildDreamDataMsg()
            });
            return;
        }

        // 9. Tree Level Up Speed Up
        if (msgId === Protocol.S_ATTRIBUTE_DREAM_LV_UP_SPEED_UP) {
            if (state.dreamLvUpEndTime > 0) {
                state.dreamLv += 1;
                state.dreamLvUpEndTime = 0;
                saveState();
            }
            pushPb(Protocol.S_ATTRIBUTE_DREAM_LV_UP_SPEED_UP, {
                ret: 0,
                dreamDataMsg: buildDreamDataMsg(),
                reward: ""
            });
            return;
        }

        // 10. Stage Challenge (Vượt ải)
        if (msgId === Protocol.S_STAGE_CHALLENGE) {
            var stageInfo = getNextStageInfo();
            var battleRecord = simulateStageBattle(stageInfo);
            var isWin = !!battleRecord.isWin;
            state.counters.stageChallenge = (state.counters.stageChallenge || 0) + 1;
            var rewStr = "";
            if (isWin) {
                state.passStageId = stageInfo.stageId;
                rewStr = stageInfo.rewards || "100004=3|100000=20";
                grantRewardString(rewStr);
            }
            saveState();

            if (isWin) {
                pushPb(Protocol.S_STAGE_DATA_SYNC, buildStageDataMsg());
                pushPb(Protocol.S_BAG_DATA_SYNC_MSG, buildBagSyncData());
                pushPb(Protocol.S_SYSTEM_UNLOCK_SYNC_MSG, buildSystemUnlockSync());
            }
            pushPb(Protocol.S_TASK_DATA_SYNC, buildTaskListMsg(true));
            pushPb(Protocol.S_STAGE_CHALLENGE, {
                ret: 0,
                allBattleRecord: battleRecord,
                challengeSuccess: isWin,
                rewards: rewStr
            });
            return;
        }

        // 11. Claim Task Reward
        if (msgId === Protocol.S_TASK_GET_REWARD) {
            var reqTaskIds = (pbMsg && pbMsg.taskId) ? pbMsg.taskId : [state.currentMainTaskId];
            var DBMgr2 = getDB();
            var allRewards = [];
            for (var ti = 0; ti < reqTaskIds.length; ti++) {
                var tid = Number(reqTaskIds[ti]);
                if (!state.tasks[tid]) state.tasks[tid] = { taskId: tid, value: "1", state: 0 };
                state.tasks[tid].state = 1;
                var tCfg = DBMgr2 && DBMgr2.GameTaskDB && DBMgr2.GameTaskDB[tid];
                if (tCfg && tCfg.rewards && tCfg.rewards !== "0") {
                    grantRewardString(tCfg.rewards);
                    allRewards.push(tCfg.rewards);
                }
                if (tid === state.currentMainTaskId) {
                    // Advance to next main task (type == 1)
                    var nextTid = tid + 1;
                    if (DBMgr2 && DBMgr2.GameTaskDB) {
                        var keys = Object.keys(DBMgr2.GameTaskDB).map(Number).sort(function (a, b) { return a - b; });
                        for (var ki = 0; ki < keys.length; ki++) {
                            if (keys[ki] > tid && Number(DBMgr2.GameTaskDB[keys[ki]].type) === 1) {
                                nextTid = keys[ki];
                                break;
                            }
                        }
                    }
                    state.currentMainTaskId = nextTid;
                    ensureMainTask();
                }
            }
            saveState();
            pushPb(Protocol.S_BAG_DATA_SYNC_MSG, buildBagSyncData());
            pushPb(Protocol.S_SYSTEM_UNLOCK_SYNC_MSG, buildSystemUnlockSync());
            pushPb(Protocol.S_TASK_DATA_SYNC, buildTaskListMsg(false));
            pushPb(Protocol.S_TASK_GET_REWARD, {
                ret: 0,
                rewards: allRewards.join("|")
            });
            return;
        }

        // 12. System Unlock Reward
        if (msgId === Protocol.S_SYSTEM_GET_REWARD_MSG) {
            var sysId = Number((pbMsg && pbMsg.systemId) || 0);
            var DBMgr3 = getDB();
            var sReward = "";
            if (sysId > 0 && state.claimedSysRewards.indexOf(sysId) < 0) {
                state.claimedSysRewards.push(sysId);
                var sCfg = DBMgr3 && DBMgr3.SystemInfoDB && DBMgr3.SystemInfoDB[sysId];
                if (sCfg && sCfg.reward && sCfg.reward !== "0") {
                    sReward = sCfg.reward;
                    grantRewardString(sReward);
                }
                saveState();
                pushPb(Protocol.S_BAG_DATA_SYNC_MSG, buildBagSyncData());
                pushPb(Protocol.S_SYSTEM_UNLOCK_SYNC_MSG, buildSystemUnlockSync());
            }
            pushPb(Protocol.S_SYSTEM_GET_REWARD_MSG, { ret: 0, reward: sReward });
            return;
        }

        // 13. Change Nickname
        if (msgId === Protocol.S_CHANGE_NICK_NAME) {
            if (pbMsg && pbMsg.nickName) {
                state.nickName = String(pbMsg.nickName);
                saveState();
            }
            pushPb(Protocol.S_CHANGE_NICK_NAME, { ret: 0 });
            return;
        }

        // 14. Client Storage
        if (msgId === Protocol.S_CLIENT_STORAGE_DATA) {
            if (pbMsg && pbMsg.dataList) {
                for (var si = 0; si < pbMsg.dataList.length; si++) {
                    var kv = pbMsg.dataList[si];
                    if (kv && kv.key != null) state.clientStorage[kv.key] = kv.value;
                }
                saveState();
            }
            pushPb(Protocol.S_CLIENT_STORAGE_DATA, { ret: 0 });
            return;
        }

        // 15. Bag Use Prop
        if (msgId === Protocol.S_BAG_USE_PROP) {
            var pId = Number((pbMsg && pbMsg.propId) || 0);
            var cnt = Number((pbMsg && pbMsg.count) || 1);
            if (pId > 0 && cnt > 0 && getBagItem(pId) >= cnt) {
                addBagItem(pId, -cnt);
                saveState();
                pushPb(Protocol.S_BAG_DATA_SYNC_MSG, buildBagSyncData([pId]));
            }
            pushPb(Protocol.S_BAG_USE_PROP, { ret: 0, reward: "", spillReward: "" });
            return;
        }

        // 16. Player Chara list / change
        if (msgId === Protocol.S_PLAYER_GET_CHARA_LIST) {
            pushPb(Protocol.S_PLAYER_GET_CHARA_LIST, { ret: 0, data: buildPlayerCharaDataMsg() });
            return;
        }
        if (msgId === Protocol.S_PLAYER_CHARA_CHANGE) {
            pushPb(Protocol.S_PLAYER_CHARA_CHANGE, {
                ret: 0,
                equipHeadIcon: getAppearanceId(),
                equipAppearanceId: getAppearanceId()
            });
            return;
        }

        // 17. Catch-all safe fallback for any other RPC
        var cmdInfo = ProtobufMgr && ProtobufMgr.cmdList && ProtobufMgr.cmdList[msgId];
        if (cmdInfo && cmdInfo.smMsgId != null) {
            var MsgClass = ProtobufMgr.getMsg(cmdInfo.smMsgId, false, true);
            var fallbackObj = MsgClass ? buildDefaultProtoObj(MsgClass, 0) : { ret: 0 };
            if (fallbackObj.ret === undefined) fallbackObj.ret = 0;
            pushPb(msgId, fallbackObj);
        }
    }

    function handleOfflineHttp(url, bodyStr) {
        var u = String(url || "");
        var body = {};
        try {
            if (bodyStr && typeof bodyStr === "string") body = JSON.parse(bodyStr);
        } catch (e) {}

        if (u.indexOf("server/list") >= 0 || u.indexOf("ServerList") >= 0) {
            var srv = {
                serverId: DEFAULT_SERVER_ID,
                serverName: DEFAULT_SERVER_NAME,
                address: "http://127.0.0.1",
                serverState: 1,
                "new": true,
                serverType: 0,
                specialType: 0,
                openTime: 1700000000000,
                preRegisterTime: 0,
                channel: 71
            };
            return JSON.stringify({
                serverList: [srv],
                playerServerList: state.roleCreated ? [DEFAULT_SERVER_ID] : [],
                recommendServerId: DEFAULT_SERVER_ID,
                labelNameMap: { "71": ["Offline"] },
                backendConfigMap: {
                    CONTROL_SIGNS_18: "0",
                    USER_AGREEMENT_TOGGLE: "0",
                    USER_AGREEMENT_TOGGLE_LIST: "0",
                    ZFB_AUTO_START_GAME: "0"
                },
                notice: {
                    title: "Hành Đạo Ký Offline",
                    content: "Chào mừng Đạo Hữu đến với phiên bản Offline!",
                    qq: ""
                },
                works: ""
            });
        }

        if (u.indexOf("player/testLogin") >= 0 || u.indexOf("player/login") >= 0) {
            if (body.uId) state.uid = String(body.uId);
            saveState();
            return JSON.stringify({
                ret: 0,
                playerId: state.playerId,
                nickName: state.nickName,
                token: "offline_token_" + state.playerId,
                realmsId: state.realmsId,
                roleId: state.roleId,
                createPlayer: !state.roleCreated,
                wsAddress: "ws://127.0.0.1:19999/offline",
                white: true
            });
        }

        if (u.indexOf("player/createRole") >= 0) {
            if (body.roleId) state.roleId = Number(body.roleId);
            state.roleCreated = true;
            saveState();
            return JSON.stringify({ result: 0, ret: 0 });
        }

        if (u.indexOf("packageUpdate") >= 0) {
            return JSON.stringify({ result: 0, updateLevel: 0, msg: "ok" });
        }

        if (u.indexOf("getAllServerName") >= 0 || u.indexOf("getLabelServerList") >= 0) {
            return JSON.stringify({
                ret: 0,
                serverList: [{
                    serverId: DEFAULT_SERVER_ID,
                    serverName: DEFAULT_SERVER_NAME,
                    address: "http://127.0.0.1",
                    serverState: 1,
                    "new": true,
                    serverType: 0
                }]
            });
        }

        return JSON.stringify({ ret: 0, result: 0, data: {} });
    }

    function installHooks() {
        // 1. GameConfig: disable U8SDK & hotfix update checks
        var gcMod = safeRequire("GameConfig");
        if (gcMod && gcMod.GameConfig) {
            gcMod.GameConfig.isU8SDK = false;
            gcMod.GameConfig.isHotFixUpdateEnable = false;
        }

        // 2. U8SDKMgr: force offline mode & safe SDK wrapper
        var u8Mod = safeRequire("U8SDKMgr");
        if (u8Mod && u8Mod.U8SDKMgr) {
            var origU8Init = u8Mod.U8SDKMgr.prototype.init;
            u8Mod.U8SDKMgr.prototype.init = function (t) {
                try {
                    if (origU8Init) origU8Init.call(this, t);
                } catch (e) {
                    console.warn("[Offline] U8SDKMgr.init caught: " + e);
                }
                if (gcMod && gcMod.GameConfig) {
                    gcMod.GameConfig.isU8SDK = false;
                    gcMod.GameConfig.isHotFixUpdateEnable = false;
                }
            };
        }

        // 3. android-sdk: prevent native ad/SDK calls from crashing or stalling
        var asdkMod = safeRequire("android-sdk");
        if (asdkMod && asdkMod.androidSdk) {
            var proto = asdkMod.androidSdk.prototype;
            proto.isSupportSdk = function () { return false; };
            proto.loadVideo = function () {};
            proto.initAd = function () {};
            proto.submitEvent = function () {};
            proto.postRoleInfo = function () {};
            proto.postCreateRoleInfo = function () {};
            proto.enterPlay = function () {};
            proto.enterServer = function () {};
            proto.enterSelectServerPage = function () {};
            proto.enterCreateRolePage = function () {};
            proto.clickEnterGameBtn = function () {};
            proto.clickCreateRoleBtn = function () {};
            proto.isRole = function () {};
            proto.clearSdkGameCenter = function () {};
            proto.showVideo = function (cb) {
                if (typeof cb === "function") setTimeout(function () { cb(true); }, 50);
            };
        }

        // 4. GameUpdateView: skip remote update checks completely
        var guvMod = safeRequire("GameUpdateView");
        if (guvMod && guvMod.GameUpdateView) {
            guvMod.GameUpdateView.prototype.checkVersion = function (cb) {
                if (typeof cb === "function") cb(null);
            };
        }

        // 5. GameLoginView: prefill offline UID so user can tap Enter Game directly
        var glvMod = safeRequire("GameLoginView");
        if (glvMod && glvMod.GameLoginView) {
            var origChangeState = glvMod.GameLoginView.prototype.changeStateToLogin;
            glvMod.GameLoginView.prototype.changeStateToLogin = function () {
                if (origChangeState) origChangeState.call(this);
                try {
                    if (this.ui && this.ui.txtAccountInput && !this.ui.txtAccountInput.text) {
                        this.ui.txtAccountInput.text = state.uid || DEFAULT_UID;
                        var sdkMod = safeRequire("SdkMgr");
                        if (sdkMod && sdkMod.SdkMgr && sdkMod.SdkMgr.inst && sdkMod.SdkMgr.inst.sdk) {
                            sdkMod.SdkMgr.inst.sdk.setUid(this.ui.txtAccountInput.text);
                            sdkMod.SdkMgr.inst.sdk.savePlayerData();
                        }
                    }
                } catch (e) {}
            };
        }

        // 6. Disable EventTracking HTTP spam
        var etMod = safeRequire("EventTracking");
        if (etMod && etMod.EventTracking) {
            etMod.EventTracking.ReportEvent = function () {};
        }
        var mpetMod = safeRequire("MainPackageEventTracking");
        if (mpetMod && mpetMod.MainPackageEventTracking) {
            mpetMod.MainPackageEventTracking.ReportEvent = function () {};
            mpetMod.MainPackageEventTracking.HttpGet = function (u, cb) { if (cb) cb(); };
            mpetMod.MainPackageEventTracking.HttpPost = function (u, d, cb) { if (cb) cb(); };
        }

        // 7. Hook HttpMgr
        var httpMod = safeRequire("HttpMgr");
        if (httpMod && httpMod.HttpMgr) {
            var HttpMgr = httpMod.HttpMgr;
            HttpMgr.sendPost = function (body, cb, url) {
                console.log("[Offline] HTTP POST " + url);
                setTimeout(function () {
                    var respText = handleOfflineHttp(url, body);
                    if (typeof cb === "function") {
                        cb({ result: HttpMgr.NORMAL_RESULT, response: respText });
                    }
                }, 15);
            };
            HttpMgr.sendRequest = function (path, params, cb, baseUrl) {
                var fullUrl = (baseUrl || "") + (path || "");
                console.log("[Offline] HTTP GET " + fullUrl);
                setTimeout(function () {
                    var respText = handleOfflineHttp(fullUrl, "");
                    if (typeof cb === "function") {
                        try { cb(JSON.parse(respText)); } catch (e) { cb({}); }
                    }
                }, 15);
            };
            HttpMgr.checkResource = function () {
                return Promise.resolve(false);
            };
        }

        // 8. Hook NetSocket to route WebSocket Protobuf RPCs to our in-process offline server
        var nsMod = safeRequire("NetSocket");
        if (nsMod && nsMod.NetSocket) {
            var NetSocket = nsMod.NetSocket;
            var NetState = nsMod.NetState;

            NetSocket.prototype.connect = function (cb) {
                var self = this;
                if (cb) self.netCallback = cb;
                self.connected = false;
                self.isConnecting = true;
                self.isOnClose = false;
                self.heartbeatCount = 0;
                self.msgCache = {};
                setTimeout(function () {
                    self.connected = true;
                    self.isConnecting = false;
                    self.sio = { readyState: 1, close: function () {}, send: function () {} };
                    console.log("[Offline] Virtual WebSocket connected");
                    if (self.netCallback) {
                        self.netCallback(NetState.NET_CONNECT, {});
                    }
                }, 25);
            };

            NetSocket.prototype.sendMsg = function (stream, msgId) {
                var reqId = msgId || (stream && stream.msgId);
                var payload = stream ? stream.pbMsg : null;
                setTimeout(function () {
                    try {
                        handlePbRequest(reqId, payload);
                    } catch (e) {
                        console.error("[Offline] handlePbRequest error msgId=" + reqId + ": " + e + "\n" + (e && e.stack));
                    }
                }, 15);
            };

            NetSocket.prototype.close = function (silent) {
                this.connected = false;
                this.isConnecting = false;
                if (this.heartbeatTimeId !== -1) {
                    clearInterval(this.heartbeatTimeId);
                    this.heartbeatTimeId = -1;
                    this.heartbeatFlag = false;
                }
                if (!silent && this.netCallback) {
                    this.netCallback(NetState.NET_CLOSE);
                }
            };
        }

        console.log("[Offline] HanhDaoKy Offline Server hooks installed successfully.");
    }

    // Export for Node.js testing as well as immediate install in Cocos
    window.__HanhDaoKyOffline = {
        installHooks: installHooks,
        handleOfflineHttp: handleOfflineHttp,
        handlePbRequest: handlePbRequest,
        getState: function () { return state; },
        resetState: function () { state = makeDefaultState(); saveState(); }
    };

    installHooks();
})();
