-- Exercise the real addon with a small mocked WoW event loop (Lua 5.1).
local function equal(actual, expected)
    assert(actual == expected, tostring(actual) .. " ~= " .. tostring(expected))
end
local function harness(previous)
    local h = {clock = 0, npc = 8670, frames = {}, creations = {}, rows = {}, requests = 0, reads = 0, loads = 0, messages = {}, config = {shift_stack_tooltips = false}}
    local function object()
        local obj = {scripts = {}, registered = {}, enabled = true}
        function obj:SetScript(name, fn) self.scripts[name] = fn end
        function obj:RegisterEvent(name) self.registered[name] = true end
        function obj:CreateFontString() return object() end
        function obj:SetText(text) self.text = text end
        function obj:Enable() self.enabled = true end
        function obj:Disable() self.enabled = false end
        function obj:Show() self.shown = true end
        return setmetatable(obj, {__index = function() return function() end end})
    end
    local env = setmetatable({AuctionLedgerDB = previous, SlashCmdList = {}, UIParent = {}}, {__index = _G})
    env._G = env
    env.CreateFrame = function(_, name, parent)
        local obj = object(); obj.TitleText = object(); obj.parent = parent
        if name then h.frames[name] = obj; env[name] = obj; h.creations[name] = (h.creations[name] or 0) + 1 end
        return obj
    end
    env.print = function(message) h.messages[#h.messages + 1] = message end
    env.GetTime = function() return h.clock end
    env.time = function() return 1793534400 + math.floor(h.clock) end
    env.debugprofilestop = function() return 0 end
    env.GetRealmName = function() return "Tést Realm" end
    env.UnitFactionGroup = function() return "Alliance" end
    env.UnitGUID = function(unit)
        equal(unit, "npc")
        return h.npc and ("Creature-0-1-0-0-" .. h.npc .. "-000001") or nil
    end
    env.Enum = {TooltipDataType = {Item = 0, Spell = 1, Unit = 2}}
    env.TooltipDataProcessor = {AddTooltipPostCall = function() error("ALD must not register a separate tooltip renderer") end}
    env.Auctionator = {
        Constants = {SCAN_DAY_0 = 1577836800},
        Config = {Options = {SHIFT_STACK_TOOLTIPS = "shift_stack_tooltips"},
            Get = function(key) return h.config[key] end, Set = function(key, value) h.config[key] = value end},
        Database = {GetFirstPrice = function() if not h.nativeMissing then return h.nativePrice or 777 end end, GetPriceAge = function() return 42 end,
            GetMeanPrice = function() return 888 end},
        Tooltip = {},
    }
    -- Fake only the renderer contract: native price lookup, native quantity setting, native vendor data.
    env.Auctionator.Tooltip.ShowTipWithPricingDBKey = function(tip, keys, link, count)
        if h.rendererError then error("native renderer failed") end
        local db = env.Auctionator.Database
        local amount = h.shift and h.config.shift_stack_tooltips and count or 1
        local price = db:GetFirstPrice(keys)
        h.lastPrice, h.lastAge, h.lastMean = price, db:GetPriceAge(keys[1]), db:GetMeanPrice(keys[1], 14)
        h.unrelatedPrice = db:GetFirstPrice({"other-item"})
        local suffix = amount > 1 and " x" .. amount or ""
        tip:AddDoubleLine("Vendor" .. suffix, 360 * amount .. "c")
        tip:AddDoubleLine("Auction" .. suffix, price and price * amount .. "c" or "Unknown")
        return "native-result", nil, "tail"
    end
    env.GetBuildInfo = function() return "1.60.1", "70888", "", 16001 end
    env.C_Item = {
        GetItemInfoInstant = function() return 13463, "", "", "", 1, 7, 0 end,
        RequestLoadItemDataByID = function() h.loads = h.loads + 1 end,
    }
    env.C_AuctionHouse = {
        ReplicateItems = function() h.requests = h.requests + 1; if h.fail then error("request rejected") end end,
        GetNumReplicateItems = function() return h.totalOverride or #h.rows end,
        GetReplicateItemInfo = function(index)
            h.reads = h.reads + 1
            local row = assert(h.rows[index + 1], "expected zero-based index")
            local itemID = row.itemID or 13463
            if row.noInfoID then itemID = nil end
            return row.name or "Dreamfoil", 1, row.incomplete and 0 or row.count or 20, 1, true, 60, "ITEM_LEVEL_ABBR",
                100, 1, row.buyout or 20000, 0, "PRIVATE_HIGH_BIDDER", "PRIVATE_BIDDER",
                "PRIVATE_OWNER", "PRIVATE_OWNER_FULL", 0, itemID, true
        end,
        GetReplicateItemLink = function(index)
            local row = h.rows[index + 1]
            if row.pending then return nil end
            return row.link or ("|cffffffff|Hitem:" .. (row.itemID or 13463) .. ":0:0:0:0:0:0:111:60:0|h[Dreamfoil]|h|r")
        end,
        GetReplicateItemTimeLeft = function() return 4 end,
    }
    local namespace = {}
    for _, name in ipairs({"AuctionLedger.lua", "AuctionatorBridge.lua"}) do
        local chunk = assert(loadfile("addon/AuctionLedger/" .. name))
        setfenv(chunk, env); chunk("AuctionLedger", namespace)
    end
    h.env, h.frame, h.ald = env, h.frames.AuctionLedgerEvents, namespace
    function h:event(name, ...) self.frame.scripts.OnEvent(self.frame, name, ...) end
    function h:command(text) self.env.SlashCmdList.AUCTIONLEDGER(text) end
    function h:advance(seconds)
        for _ = 1, math.ceil(seconds / 0.05) do
            self.clock = self.clock + 0.05
            for _, frame in pairs(self.frames) do
                local update = frame.scripts.OnUpdate
                if update then update(frame, 0.05) end
            end
        end
    end
    function h:tooltip(link, count)
        local tip = {lines = {}, data = {type = env.Enum.TooltipDataType.Item}, link = link, count = count or 1}
        function tip:GetItem() return "Dreamfoil", self.link end
        function tip:GetName() return "GameTooltip" end
        function tip:NumLines() return #self.lines end
        function tip:GetPrimaryTooltipData() return self.data end
        function tip:IsShown() return true end
        function tip:AddDoubleLine(left, right)
            local index = #self.lines + 1
            self.lines[index] = {left = left, right = right}
            env["GameTooltipTextLeft" .. index] = {GetText = function() return self.lines[index].left end}
        end
        function tip:RebuildFromTooltipInfo()
            self.lines = {}
            local id = self.link and self.link:match("item:(%d+)")
            if id and env.Auctionator then return env.Auctionator.Tooltip.ShowTipWithPricingDBKey(self, {id}, self.link, self.count) end
        end
        env.GameTooltip = tip; tip:RebuildFromTooltipInfo()
        return tip
    end
    h:event("ADDON_LOADED", "AuctionLedger")
    env.AuctionHouseFrame = object()
    h:event("ADDON_LOADED", "Blizzard_AuctionHouseUI")
    h:event("AUCTION_HOUSE_SHOW")
    return h
end

local success = harness()
success.rows = {{}, {buyout = 12000, count = 10}}
success:command("scan")
success:advance(1)
equal(success.reads, 0) -- A stale cached list is not read before a new event.
success:event("REPLICATE_ITEM_LIST_UPDATE")
success:advance(16)
equal(success.requests, 1)
equal(#success.env.AuctionLedgerDB.scans, 1)
local saved = success.env.AuctionLedgerDB.scans[1]
equal(saved.coverage, "partial"); equal(saved.captured, 2); equal(saved.unresolved, 0)
equal(saved.captureComplete, true)
assert(success.messages[#success.messages]:find("Capture complete", 1, true))
equal(#saved.variants, 1) -- Per-instance unique IDs do not split fungible items.
equal(saved.variants[1].itemString, "item:13463")
equal(saved.rows[1], "1;20;20000;100;0;4")
equal(success.frame.scripts.OnUpdate, nil)
success:command("scan"); equal(success.requests, 1) -- Local cooldown is respected.
success:advance(901); success:command("scan")
success:event("REPLICATE_ITEM_LIST_UPDATE"); success:advance(16)
equal(#success.env.AuctionLedgerDB.scans, 2)
equal(success.frame.registered.REPLICATE_ITEM_LIST_UPDATE, true)

local streamed = harness()
streamed.rows = {{}}
streamed:command("scan"); streamed:event("REPLICATE_ITEM_LIST_UPDATE"); streamed:advance(10)
equal(#streamed.env.AuctionLedgerDB.scans, 0)
equal(streamed.frames.AuctionLedgerSaveButton.text, "Save now")
streamed:command("status")
assert(streamed.messages[#streamed.messages]:find("cataloging complete", 1, true))
assert(streamed.messages[#streamed.messages]:find("autosave in", 1, true))
streamed.rows[2] = {buyout = 30000}
streamed:event("REPLICATE_ITEM_LIST_UPDATE"); streamed:advance(10)
equal(#streamed.env.AuctionLedgerDB.scans, 0)
streamed:advance(6)
equal(streamed.env.AuctionLedgerDB.scans[1].captured, 2)

local saveComplete = harness(); saveComplete.rows = {{}}
saveComplete:command("scan"); saveComplete:event("REPLICATE_ITEM_LIST_UPDATE"); saveComplete:advance(1)
saveComplete.frames.AuctionLedgerSaveButton.scripts.OnClick()
equal(saveComplete.env.AuctionLedgerDB.scans[1].captureComplete, true)
equal(saveComplete.env.AuctionLedgerDB.scans[1].reason, "All returned rows captured; saved by user")
equal(saveComplete.frame.scripts.OnUpdate, nil)
local saveGrowth = harness(); saveGrowth.rows = {{}}
saveGrowth:command("scan"); saveGrowth:event("REPLICATE_ITEM_LIST_UPDATE"); saveGrowth:advance(1)
saveGrowth.rows[2] = {} -- A new row arrives between the last poll and a manual save.
saveGrowth:command("save")
equal(saveGrowth.env.AuctionLedgerDB.scans[1].captureComplete, false)
equal(saveGrowth.env.AuctionLedgerDB.scans[1].received, 2)
equal(saveGrowth.env.AuctionLedgerDB.scans[1].unread, 1)

local delayed = harness()
delayed.rows = {{}, {pending = true}}
delayed:command("scan"); delayed:event("REPLICATE_ITEM_LIST_UPDATE"); delayed:advance(2)
equal(delayed.loads, 1)
equal(#delayed.env.AuctionLedgerDB.scans, 0)
delayed.rows[2].pending = false
delayed:event("REPLICATE_ITEM_LIST_UPDATE"); delayed:advance(16)
equal(delayed.env.AuctionLedgerDB.scans[1].captured, 2)

local unresolved = harness()
unresolved.rows = {{}, {pending = true}}
unresolved:command("scan"); unresolved:event("REPLICATE_ITEM_LIST_UPDATE"); unresolved:advance(92)
equal(unresolved.env.AuctionLedgerDB.scans[1].captured, 1)
equal(unresolved.env.AuctionLedgerDB.scans[1].unresolved, 1)
equal(unresolved.env.AuctionLedgerDB.scans[1].coverage, "partial")
equal(unresolved.env.AuctionLedgerDB.scans[1].captureComplete, false)

local notified = harness()
notified.rows = {{}, {pending = true}}
notified:command("scan"); notified:event("REPLICATE_ITEM_LIST_UPDATE")
for _ = 1, 92 do notified:event("REPLICATE_ITEM_LIST_UPDATE"); notified:advance(1) end
equal(notified.env.AuctionLedgerDB.scans[1].captured, 1)
equal(notified.env.AuctionLedgerDB.scans[1].unresolved, 1)
equal(notified.frame.scripts.OnUpdate, nil)

local eventSpam = harness(); eventSpam.rows = {{}}
eventSpam:command("scan")
for _ = 1, 16 do eventSpam:event("REPLICATE_ITEM_LIST_UPDATE"); eventSpam:advance(1) end
equal(#eventSpam.env.AuctionLedgerDB.scans, 1) -- Cache events cannot delay an already captured list forever.

local trickle = harness(); trickle.rows = {{}}
for n = 2, 11 do trickle.rows[n] = {pending = true} end
trickle:command("scan"); trickle:event("REPLICATE_ITEM_LIST_UPDATE"); trickle:advance(1)
for n = 2, 4 do
    trickle:advance(20); trickle.rows[n].pending = false
    trickle:event("ITEM_DATA_LOAD_RESULT", 13463, true); trickle:advance(0.05)
end
trickle:advance(35)
equal(trickle.env.AuctionLedgerDB.scans[1].captured, 4)
equal(trickle.env.AuctionLedgerDB.scans[1].pendingItemData, 7)
equal(trickle.env.AuctionLedgerDB.scans[1].unread, 0)
assert(trickle.env.AuctionLedgerDB.scans[1].reason:find("retry budget", 1, true))

local fresh = harness()
for n = 1, 20000 do fresh.rows[n] = {pending = true} end
fresh:command("scan"); fresh:event("REPLICATE_ITEM_LIST_UPDATE"); fresh:advance(3)
fresh.rows[20001] = {itemID = 13466}
fresh:event("REPLICATE_ITEM_LIST_UPDATE"); fresh:advance(0.05); fresh:command("save")
equal(fresh.env.AuctionLedgerDB.scans[1].captured, 1) -- New rows bypass the 20,000-row retry backlog.
equal(fresh.env.AuctionLedgerDB.scans[1].variants[1].itemId, 13466)
equal(fresh.env.AuctionLedgerDB.scans[1].pendingItemData, 20000)

local wake = harness()
for n = 1, 19999 do wake.rows[n] = {pending = true} end
wake.rows[20000] = {pending = true, itemID = 13468}
wake:command("scan"); wake:event("REPLICATE_ITEM_LIST_UPDATE"); wake:advance(3)
wake.rows[20000].pending = false
wake:event("ITEM_DATA_LOAD_RESULT", 13468, true); wake:advance(0.05); wake:command("save")
equal(wake.env.AuctionLedgerDB.scans[1].captured, 1) -- Loaded tail row is captured on the next tick.
equal(wake.env.AuctionLedgerDB.scans[1].variants[1].itemId, 13468)

local details = harness(); details.rows = {{incomplete = true}}
details:command("scan"); details:event("REPLICATE_ITEM_LIST_UPDATE"); details:advance(1)
equal(details.loads, 1) -- Request known item data even when other row fields are incomplete.
details.rows[1].incomplete = false; details:event("ITEM_DATA_LOAD_RESULT", 13463, true); details:advance(16)
equal(details.env.AuctionLedgerDB.scans[1].captured, 1)
local linkIdentity = harness(); linkIdentity.rows = {{noInfoID = true}}
linkIdentity:command("scan"); linkIdentity:event("REPLICATE_ITEM_LIST_UPDATE"); linkIdentity:advance(16)
equal(linkIdentity.env.AuctionLedgerDB.scans[1].variants[1].itemId, 13463) -- Actual item link supplies the ID.
local loadFailure = harness(); loadFailure.rows = {{pending = true}}
loadFailure:command("scan"); loadFailure:event("REPLICATE_ITEM_LIST_UPDATE"); loadFailure:advance(1)
for _ = 1, 5 do loadFailure:event("ITEM_DATA_LOAD_RESULT", 13463, false); loadFailure:advance(2) end
equal(loadFailure.loads, 3); loadFailure:command("cancel")
local stillPending = harness(); stillPending.rows = {{pending = true}}
stillPending:command("scan"); stillPending:event("REPLICATE_ITEM_LIST_UPDATE"); stillPending:advance(0.05)
for _ = 1, 3 do
    stillPending:event("ITEM_DATA_LOAD_RESULT", 13463, true); stillPending:advance(0.05)
end
local reads = stillPending.reads
stillPending.clock = 10; stillPending:advance(0.05)
equal(stillPending.reads - reads, 1) -- A successful load with an unready replicate row must not duplicate retry entries.
stillPending:command("cancel")

local old = success.env.AuctionLedgerDB.scans[1]
local stopped = harness({version = 1, scans = {old}})
stopped.clock = 100
stopped.rows = {{buyout = 15000, count = 5}, {pending = true}}
stopped:command("scan"); stopped:event("REPLICATE_ITEM_LIST_UPDATE"); stopped:advance(1)
equal(stopped.frames.AuctionLedgerSaveButton.enabled, true)
stopped:command("save")
equal(#stopped.env.AuctionLedgerDB.scans, 2)
equal(stopped.env.AuctionLedgerDB.scans[1], old)
local partial = stopped.env.AuctionLedgerDB.scans[2]
equal(partial.reason, "Stopped early by user")
equal(partial.status, "saved"); equal(partial.coverage, "partial")
equal(partial.captured, 1); equal(partial.received, 2); equal(partial.unresolved, 1)
equal(partial.rows[1], "1;5;15000;100;0;4")
equal(stopped.frame.scripts.OnUpdate, nil)
equal(stopped.frames.AuctionLedgerSaveButton.enabled, false)
stopped:command("save"); stopped:command("cancel"); stopped:advance(100)
equal(#stopped.env.AuctionLedgerDB.scans, 2) -- No duplicate or post-save mutations.

local empty = harness()
empty.rows = {{}}
empty:command("scan"); empty:command("save")
equal(#empty.env.AuctionLedgerDB.scans, 0)
equal(empty.frames.AuctionLedgerSaveButton.enabled, false)
assert(empty.frame.scripts.OnUpdate) -- An empty save leaves the scan running.
empty:command("cancel")

local clicked = harness()
clicked.rows = {{}, {pending = true}}
clicked:command("scan"); clicked:event("REPLICATE_ITEM_LIST_UPDATE"); clicked:advance(1)
clicked.frames.AuctionLedgerSaveButton.scripts.OnClick()
equal(clicked.env.AuctionLedgerDB.scans[1].reason, "Stopped early by user")
equal(clicked.env.AuctionLedgerDB.scans[1].captured, 1)

for _, mode in ipairs({"cancel", "close", "timeout", "shrink", "error"}) do
    local h = harness({version = 1, scans = {old}})
    h.rows = {{}, {}}
    if mode == "error" then h.fail = true end
    h:command("scan")
    if mode == "timeout" then h:advance(901)
    elseif mode == "cancel" then h:command("cancel")
    elseif mode == "close" then h:event("AUCTION_HOUSE_CLOSED")
    elseif mode == "shrink" then
        h:event("REPLICATE_ITEM_LIST_UPDATE"); h:advance(1)
        h.rows[2] = nil; h:advance(1)
    end
    equal(#h.env.AuctionLedgerDB.scans, 1)
    equal(h.env.AuctionLedgerDB.scans[1], old)
    equal(h.frame.scripts.OnUpdate, nil)
end

local large = harness()
for _ = 1, 1001 do large.rows[#large.rows + 1] = {} end
large:command("scan"); large:event("REPLICATE_ITEM_LIST_UPDATE"); large:advance(0.05)
equal(large.reads, 400)
large:command("cancel")
equal(#large.env.AuctionLedgerDB.scans, 0)

local rowLimit = harness()
for n = 1, 500 do rowLimit.rows[n] = {} end
rowLimit.totalOverride = 500000
rowLimit:command("scan"); rowLimit:event("REPLICATE_ITEM_LIST_UPDATE"); rowLimit:advance(0.05)
rowLimit.totalOverride = 500001; rowLimit:advance(0.05)
equal(rowLimit.env.AuctionLedgerDB.scans[1].captured, 400)
equal(rowLimit.env.AuctionLedgerDB.scans[1].received, 500001)
equal(rowLimit.env.AuctionLedgerDB.scans[1].unread, 499601)
local timeLimit = harness()
for n = 1, 1000 do timeLimit.rows[n] = {} end
timeLimit:command("scan"); timeLimit:event("REPLICATE_ITEM_LIST_UPDATE"); timeLimit:advance(0.05)
timeLimit.clock = 1000; timeLimit:advance(0.05)
equal(timeLimit.env.AuctionLedgerDB.scans[1].status, "saved")
assert(timeLimit.env.AuctionLedgerDB.scans[1].captured > 0)
assert(timeLimit.env.AuctionLedgerDB.scans[1].reason:find("time budget", 1, true))

local fullSize = harness()
for n = 1, 300000 do fullSize.rows[n] = {itemID = 100000 + n % 25000} end
fullSize:command("scan"); fullSize:event("REPLICATE_ITEM_LIST_UPDATE"); fullSize:advance(45)
local fullScan = fullSize.env.AuctionLedgerDB.scans[1]
equal(fullScan.captured, 300000); equal(fullScan.unresolved, 0)
equal(fullScan.captureComplete, true); equal(fullSize.frame.scripts.OnUpdate, nil)
assert(fullScan.estimatedBytes > 24 * 1024 * 1024) -- Old storage guard rejected this valid market size.

local storage = harness()
local modifiers = string.rep(":1234567890123", 130)
for n = 1, 23000 do storage.rows[n] = {link = "|Hitem:13463:" .. n .. modifiers .. "|h[Variant]|h"} end
storage:command("scan"); storage:event("REPLICATE_ITEM_LIST_UPDATE"); storage:advance(10)
local bounded = assert(storage.env.AuctionLedgerDB.scans[1], "Storage limit must save the captured rows")
equal(bounded.status, "saved"); equal(bounded.coverage, "partial")
assert(bounded.captured > 20000 and bounded.captured < 23000)
assert(bounded.reason:find("storage budget", 1, true))

local retention = harness()
retention.rows = {{}}
for n = 1, 5 do
    retention:command("scan"); retention:event("REPLICATE_ITEM_LIST_UPDATE"); retention:advance(16)
    if n < 5 then retention:advance(901) end
end
equal(#retention.env.AuctionLedgerDB.scans, 3)
local neutral = harness()
neutral.rows = {{buyout = 5000, count = 10}}
neutral:command("scan neutral"); neutral:event("REPLICATE_ITEM_LIST_UPDATE"); neutral:advance(16)
equal(neutral.env.AuctionLedgerDB.scans[1].faction, "Neutral")
equal(neutral.env.AuctionLedgerDB.lastAttempt.faction, "Neutral")

local buttons = harness()
buttons.rows = {{}}
buttons:command("")
buttons.frames.AuctionLedgerNeutralButton.scripts.OnClick()
equal(buttons.frames.AuctionLedgerFactionButton.enabled, false)
equal(buttons.frames.AuctionLedgerNeutralButton.enabled, false)
buttons:event("REPLICATE_ITEM_LIST_UPDATE"); buttons:advance(16)
equal(buttons.env.AuctionLedgerDB.scans[1].faction, "Neutral")
equal(buttons.frames.AuctionLedgerFactionButton.enabled, true)
equal(buttons.frames.AuctionLedgerNeutralButton.enabled, true)
buttons:advance(901); buttons:command("scan faction")
buttons:event("REPLICATE_ITEM_LIST_UPDATE"); buttons:advance(16)
equal(buttons.env.AuctionLedgerDB.scans[2].faction, "Alliance")
for n = 1, 4 do
    buttons:advance(901); buttons.frames.AuctionLedgerFactionButton.scripts.OnClick()
    buttons:event("REPLICATE_ITEM_LIST_UPDATE"); buttons:advance(16)
end
equal(#buttons.env.AuctionLedgerDB.scans, 3)
equal(buttons.env.AuctionLedgerDB.scans[1].faction, "Neutral") -- Repeated faction scans keep the latest other house.
equal(buttons.env.AuctionLedgerDB.scans[3].faction, "Alliance")

local unknown = harness()
unknown.env.UnitFactionGroup = function() return nil end
unknown:command("scan faction"); equal(unknown.requests, 0)
unknown:command("scan neutral"); equal(unknown.requests, 1)
unknown:command("cancel")

for _, id in ipairs({8661, 9857, 9858, 15677, 15681}) do
    local h = harness(); h.npc = id; h.rows = {{}}
    h:command("")
    equal(h.frames.AuctionLedgerAutoButton.enabled, true)
    h.frames.AuctionLedgerAutoButton.scripts.OnClick()
    h:event("REPLICATE_ITEM_LIST_UPDATE"); h:advance(16)
    equal(h.env.AuctionLedgerDB.scans[1].faction, "Neutral")
end
for _, example in ipairs({{8719, "Alliance"}, {8672, "Horde"}}) do
    local h = harness(); h.npc = example[1]; h.rows = {{}}
    h:command("scan"); h:event("REPLICATE_ITEM_LIST_UPDATE"); h:advance(16)
    equal(h.env.AuctionLedgerDB.scans[1].faction, example[2])
end
local learned = harness(); learned.npc = 999999; learned.rows = {{}}
learned:command(""); equal(learned.frames.AuctionLedgerAutoButton.enabled, false)
learned:command("scan"); equal(learned.requests, 0) -- Unknown never silently defaults to faction.
learned:command("scan neutral"); learned:event("REPLICATE_ITEM_LIST_UPDATE"); learned:advance(16)
equal(learned.env.AuctionLedgerDB.auctioneers[999999], "Neutral")
equal(learned.frames.AuctionLedgerAutoButton.enabled, true)
local remembered = harness(learned.env.AuctionLedgerDB)
remembered.npc = 999999; remembered:advance(901); remembered.rows = {{}}
remembered:command("scan"); remembered:event("REPLICATE_ITEM_LIST_UPDATE"); remembered:advance(16)
equal(remembered.env.AuctionLedgerDB.scans[2].faction, "Neutral")
local noNPC = harness(); noNPC.npc = nil
noNPC:command("scan"); equal(noNPC.requests, 0)
local opaqueGUID = harness(); opaqueGUID.rows = {{}}
opaqueGUID.env.UnitGUID = function() return "Creature-x-a1b2-hidden-zone-8661-deadbeef" end
opaqueGUID:command("scan"); opaqueGUID:event("REPLICATE_ITEM_LIST_UPDATE"); opaqueGUID:advance(16)
equal(opaqueGUID.env.AuctionLedgerDB.scans[1].faction, "Neutral")
local changedNPC = harness(); changedNPC.rows = {{}}
changedNPC:command("scan"); changedNPC.npc = 8661
changedNPC:event("REPLICATE_ITEM_LIST_UPDATE"); changedNPC:advance(1)
equal(#changedNPC.env.AuctionLedgerDB.scans, 0)

local prices = harness({version = 1, scans = {saved, success.env.AuctionLedgerDB.scans[2], neutral.env.AuctionLedgerDB.scans[1]}})
prices.clock = 2000
local baseLink = "|cffffffff|Hitem:13463:0:0:0:0:0:0:999:50:0|h[Dreamfoil]|h|r"
local tip = prices:tooltip(baseLink, 9)
equal(#tip.lines, 2); equal(tip.lines[2].right, "777c"); equal(prices.lastAge, 42) -- Native price and age while indexing.
prices:advance(0.05)
equal(#tip.lines, 2); equal(tip.lines[1].left, "Vendor"); equal(tip.lines[2].left, "Auction")
equal(tip.lines[2].right, "1000c"); equal(prices.lastAge, 0)
equal(prices.unrelatedPrice, 777) -- Other lookups inside rendering do not receive this item's price.
equal(prices.env.Auctionator.Database:GetFirstPrice({"13463"}), 777) -- No database/context pollution.
equal(prices.env.Auctionator.Database:GetPriceAge("13463"), 42)
equal(prices.config.shift_stack_tooltips, true)
prices.shift = true; tip:RebuildFromTooltipInfo()
equal(tip.lines[1].left, "Vendor x9"); equal(tip.lines[1].right, "3240c")
equal(tip.lines[2].left, "Auction x9"); equal(tip.lines[2].right, "9000c")
prices.shift = false; tip:RebuildFromTooltipInfo()
equal(tip.lines[2].right, "1000c")
prices.npc = 8661; prices:event("AUCTION_HOUSE_SHOW")
equal(tip.lines[2].right, "1000c"); equal(prices.lastMean, 888) -- Tooltips always use Faction, even at Neutral.
prices:event("AUCTION_HOUSE_CLOSED")
equal(tip.lines[2].right, "1000c"); equal(prices.lastMean, 888) -- Faction outside the AH.
prices:event("AUCTION_HOUSE_SHOW") -- Neutral remains detected until a manual Faction choice.
prices.npc = 8670; prices:event("AUCTION_HOUSE_SHOW")
local variantLink = "|Hitem:13463:0:0:0:0:0:-18:1:60:0|h[Different variant]|h"
tip = prices:tooltip(variantLink, 9)
equal(tip.lines[2].right, "777c"); equal(prices.lastAge, 42) -- Missing exact variants retain Auctionator's fallback and age.
prices.shift = true; tip:RebuildFromTooltipInfo()
equal(tip.lines[2].right, "6993c"); equal(tip.lines[1].right, "3240c") -- Native stack/vendor totals also work on fallback.
prices.shift = false
prices.nativeMissing = true
equal(prices:tooltip(variantLink).lines[2].right, "Unknown") -- Unknown only when neither source has a price.
equal(prices:tooltip(baseLink).lines[2].right, "1000c") -- ALD still works when the native cache has no price.
prices.nativeMissing = false
tip = prices:tooltip(baseLink)
prices.rows = {{buyout = 30000, count = 10}, {pending = true}}
prices:command("scan faction"); prices:event("REPLICATE_ITEM_LIST_UPDATE"); prices:advance(1)
prices:command("save")
equal(#tip.lines, 2); equal(tip.lines[2].right, "3000c") -- Native Auction row updates immediately.
prices:advance(901); prices.rows = {{buyout = 1, count = 1}}
prices:command("scan faction"); prices:command("cancel")
equal(prices:tooltip(baseLink).lines[2].right, "3000c")
prices.rendererError = true
assert(not pcall(function() prices:tooltip(baseLink) end))
equal(prices.env.Auctionator.Database:GetFirstPrice({"13463"}), 777) -- Error path restores context.
prices.rendererError = false
tip = prices:tooltip(baseLink)
local first, middle, last = tip:RebuildFromTooltipInfo()
equal(first, "native-result"); equal(middle, nil); equal(last, "tail")

local protectedTooltip = harness({version = 1, scans = {saved}})
local nonItem = protectedTooltip:tooltip(baseLink)
nonItem.RebuildFromTooltipInfo = function() error("must not rebuild a protected or non-item tooltip") end
for _, kind in ipairs({protectedTooltip.env.Enum.TooltipDataType.Unit, protectedTooltip.env.Enum.TooltipDataType.Spell}) do
    nonItem.data.type = kind
    protectedTooltip.ald.RefreshAuctionator()
    protectedTooltip.ald.RefreshPrices()
    protectedTooltip:advance(0.1) -- Async indexing completion must also leave unit/spell tooltips alone.
end
nonItem.data = nil; protectedTooltip.ald.RefreshAuctionator()
nonItem.data = {type = protectedTooltip.env.Enum.TooltipDataType.Item}
protectedTooltip.env.issecretvalue = function(value) return value == nonItem.data.type end
protectedTooltip.ald.RefreshAuctionator()
protectedTooltip.env.issecretvalue = nil
nonItem.IsForbidden = function() return true end
protectedTooltip.ald.RefreshAuctionator()
nonItem.IsForbidden = nil; nonItem.GetPrimaryTooltipData = nil
protectedTooltip.ald.RefreshAuctionator()

local bigScan = {status = "saved", realm = "Tést Realm", faction = "Alliance", timestamp = 1793534400, coverage = "partial",
    variants = {{itemString = "item:13463"}}, rows = {}}
for n = 1, 3000 do bigScan.rows[n] = "1;1;1000;0;0;0" end
bigScan.rows[3000] = "1;1;5;0;0;0"
local indexed = harness({version = 1, scans = {bigScan}})
tip = indexed:tooltip(baseLink); indexed:advance(0.05); equal(tip.lines[2].right, "777c")
for _ = 1, 3 do indexed.ald.RefreshPrices(); indexed:advance(0.05) end
equal(#tip.lines, 2); equal(tip.lines[2].right, "5c") -- Repeated refreshes preserve indexing progress.
tip.link = nil; tip:RebuildFromTooltipInfo(); equal(#tip.lines, 0)

local foreign = harness({version = 1, scans = {{status = "saved", realm = "Other Realm", faction = "Neutral", timestamp = 1793534400,
    variants = {{itemString = "item:13463"}}, rows = {"1;1;1;0;0;0"}},
    {status = "saved", realm = "Tést Realm", faction = "Horde", timestamp = 1793534400,
    variants = {{itemString = "item:13463"}}, rows = {"1;1;2;0;0;0"}}}})
foreign:advance(0.1); equal(foreign:tooltip(baseLink).lines[2].right, "2c") -- Faction labels share one economy.
foreign.npc = 8661; foreign:event("AUCTION_HOUSE_SHOW")
equal(foreign.env.GameTooltip.lines[2].right, "2c") -- Opening Neutral cannot switch tooltip prices.
local onlyNeutral = harness({version = 1, scans = {neutral.env.AuctionLedgerDB.scans[1]}})
onlyNeutral:advance(0.1); onlyNeutral:tooltip(baseLink)
equal(onlyNeutral.env.GameTooltip.lines[2].right, "777c") -- Neutral observations never replace the native fallback.
onlyNeutral.nativeMissing = true
equal(onlyNeutral:tooltip(baseLink).lines[2].right, "Unknown") -- A Neutral-only observation cannot fill a missing Faction price.

local olderPrices = {status = "saved", realm = "Older label", faction = "Horde", timestamp = 1793534400 - 86400, estimatedBytes = 1024,
    variants = {{itemString = "item:13463"}, {itemString = "item:13463:0:0:0:0:0:-18"}},
    rows = {"1;1;10;0;0;0", "2;1;500;0;0;0"}}
local newerPrices = {status = "saved", realm = "Newer label", faction = "Alliance", timestamp = 1793534400, estimatedBytes = 1024,
    variants = {{itemString = "item:13463"}}, rows = {"1;1;2000;0;0;0"}}
local sparse = harness({version = 1, scans = {olderPrices, newerPrices}})
sparse:advance(0.1)
equal(sparse:tooltip(baseLink).lines[2].right, "2000c"); equal(sparse.lastAge, 0)
equal(sparse:tooltip(variantLink).lines[2].right, "500c"); equal(sparse.lastAge, 1)
sparse.rows = {{buyout = 30000, count = 10}, {pending = true}}
sparse:command("scan"); sparse:event("REPLICATE_ITEM_LIST_UPDATE"); sparse:advance(1); sparse:command("save")
equal(sparse:tooltip(baseLink).lines[2].right, "3000c")
equal(sparse:tooltip(variantLink).lines[2].right, "500c"); equal(sparse.lastAge, 1) -- Missing items keep their own observation age.

local pendingNewer = harness({version = 1, scans = {olderPrices}})
pendingNewer:advance(0.1)
tip = pendingNewer:tooltip(baseLink)
equal(tip.lines[2].right, "10c"); equal(pendingNewer.lastAge, 1)
local pendingScan = {status = "saved", realm = "Test", faction = "Faction", timestamp = 1793534400,
    variants = {{itemString = "item:13463"}}, rows = {}}
for n = 1, 3000 do pendingScan.rows[n] = "1;1;2000;0;0;4" end
pendingNewer.env.AuctionLedgerDB.scans[2] = pendingScan
pendingNewer.ald.RefreshPrices(); pendingNewer:advance(0.05)
equal(tip.lines[2].right, "10c"); equal(pendingNewer.lastAge, 1) -- Ready stale ALD prices remain usable during a newer index.
pendingNewer:advance(0.2)
equal(tip.lines[2].right, "2000c"); equal(pendingNewer.lastAge, 0)

local bow = harness({version = 1, scans = {{status = "saved", realm = "Test label", faction = "Alliance", timestamp = 1793534400,
    estimatedBytes = 1024, variants = {{itemString = "item:4087:0:0:0:0:0:0:0:0:0:0:0:1:12728"}},
    rows = {"1;1;38799;0;0;4"}}}})
bow.nativePrice = 30000
local agilityLink = "|Hitem:4087::::::::44:1486:::1:12728::::::|h[Trueshot Bow of Agility]|h"
tip = bow:tooltip(agilityLink); equal(tip.lines[2].right, "30000c") -- Retain the old native value until ALD finishes indexing.
bow:advance(0.1); equal(tip.lines[2].right, "38799c") -- Bag links match saved bonus-based Agility variants.
bow.rows = {{itemID = 4087, link = agilityLink, count = 1, buyout = 38699}, {pending = true}}
bow:command("scan"); bow:event("REPLICATE_ITEM_LIST_UPDATE"); bow:advance(1); bow:command("save")
equal(tip.lines[2].right, "38699c") -- A partial save replaces an old native Auction price immediately.
bow:advance(901); bow.rows = {{itemID = 4087, link = agilityLink, count = 1, buyout = 1}}
bow:command("scan neutral"); bow:event("REPLICATE_ITEM_LIST_UPDATE"); bow:advance(16)
equal(tip.lines[2].right, "38699c") -- Saving a newer Neutral scan cannot replace the Faction price.

local login = harness({version = 1, scans = {saved}})
login.env.UnitFactionGroup = function() return nil end
login:event("AUCTION_HOUSE_CLOSED"); login:event("ADDON_LOADED", "AuctionLedger"); login:advance(0.1)
tip = login:tooltip(baseLink); equal(tip.lines[2].right, "1000c") -- Faction prices do not depend on player-faction readiness.
login.env.UnitFactionGroup = function() return "Alliance" end
login:event("PLAYER_LOGIN"); login:advance(0.1)
equal(tip.lines[2].right, "1000c")
login.env.issecretvalue = function(value) return value == baseLink end
tip:RebuildFromTooltipInfo(); equal(tip.lines[2].right, "777c") -- Protected links are left to the native renderer.

local variants = harness()
variants.rows = {{}, {link = variantLink, buyout = 10000}}
variants:command("scan"); variants:event("REPLICATE_ITEM_LIST_UPDATE"); variants:advance(16)
equal(variants:tooltip(baseLink).lines[2].right, "1000c")
equal(variants:tooltip(variantLink).lines[2].right, "500c")

local menu = harness()
equal(menu.frames.AuctionLedgerAHScanButton.text, "Scan")
equal(menu.frames.AuctionLedgerWindow, nil)
menu.frames.AuctionLedgerAHScanButton.scripts.OnClick()
equal(menu.frames.AuctionLedgerWindow.shown, true)
equal(menu.frames.AuctionLedgerAHScanButton.parent, menu.env.AuctionHouseFrame)
menu:event("AUCTION_HOUSE_SHOW"); menu:event("ADDON_LOADED", "Blizzard_AuctionHouseUI")
equal(menu.creations.AuctionLedgerAHScanButton, 1)
menu.env.Auctionator = nil; menu:event("PLAYER_LOGIN") -- Scanner stays usable without Auctionator; no own tooltip rows.
equal(#menu:tooltip(baseLink).lines, 0)

local function literal(value)
    if type(value) == "string" then return string.format("%q", value) end
    if type(value) == "number" or type(value) == "boolean" then return tostring(value) end
    local fields = {}
    for key, entry in pairs(value) do fields[#fields + 1] = "[" .. literal(key) .. "]=" .. literal(entry) end
    return "{" .. table.concat(fields, ",") .. "}"
end
local data = "AuctionLedgerDB = " .. literal(success.env.AuctionLedgerDB)
assert(not data:find("PRIVATE_", 1, true))
if arg[1] then local file = assert(io.open(arg[1], "wb")); file:write(data); file:close() end
if arg[2] then
    local file = assert(io.open(arg[2], "wb"))
    file:write("AuctionLedgerDB = " .. literal(stopped.env.AuctionLedgerDB)); file:close()
end
if arg[3] then
    local paired = {version = 1, scans = {success.env.AuctionLedgerDB.scans[1], success.env.AuctionLedgerDB.scans[2], neutral.env.AuctionLedgerDB.scans[1]}}
    local file = assert(io.open(arg[3], "wb")); file:write("AuctionLedgerDB = " .. literal(paired)); file:close()
end
if arg[4] then
    local file = assert(io.open(arg[4], "wb"))
    file:write("AuctionLedgerDB = " .. literal({version = 1, scans = {fullScan}})); file:close()
end
print("PASS: streaming, large scans, storage/time partial saves, bounded item-data retries, stop-and-save, house detection, cross-house retention, native Auctionator pricing and stack/vendor totals, exact variants, bounded indexing, immediate updates, AH Scan button, cancellation and private fields")
return harness
