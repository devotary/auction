-- Exercise the real addon with a small mocked WoW event loop (Lua 5.1).
local function equal(actual, expected)
    assert(actual == expected, tostring(actual) .. " ~= " .. tostring(expected))
end
local function harness(previous)
    local h = {clock = 0, npc = 8670, frames = {}, rows = {}, requests = 0, reads = 0, loads = 0, messages = {}}
    local function object()
        local obj = {scripts = {}, registered = {}, enabled = true}
        function obj:SetScript(name, fn) self.scripts[name] = fn end
        function obj:RegisterEvent(name) self.registered[name] = true end
        function obj:CreateFontString() return object() end
        function obj:SetText(text) self.text = text end
        function obj:Enable() self.enabled = true end
        function obj:Disable() self.enabled = false end
        return setmetatable(obj, {__index = function() return function() end end})
    end
    local env = setmetatable({AuctionLedgerDB = previous, SlashCmdList = {}, UIParent = {}}, {__index = _G})
    env._G = env
    env.CreateFrame = function(_, name)
        local obj = object(); obj.TitleText = object()
        if name then h.frames[name] = obj end
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
    env.Enum = {TooltipDataType = {Item = 0}}
    env.TooltipDataProcessor = {AddTooltipPostCall = function(kind, callback)
        equal(kind, 0); h.tooltipCallback = callback
    end}
    env.GetCoinTextureString = function(price) return price .. "c" end
    env.GetBuildInfo = function() return "1.60.1", "70888", "", 16001 end
    env.C_Item = {
        GetItemInfoInstant = function() return 13463, "", "", "", 1, 7, 0 end,
        RequestLoadItemDataByID = function() h.loads = h.loads + 1 end,
    }
    env.C_AuctionHouse = {
        ReplicateItems = function() h.requests = h.requests + 1; if h.fail then error("request rejected") end end,
        GetNumReplicateItems = function() return #h.rows end,
        GetReplicateItemInfo = function(index)
            h.reads = h.reads + 1
            local row = assert(h.rows[index + 1], "expected zero-based index")
            return row.name or "Dreamfoil", 1, row.count or 20, 1, true, 60, "ITEM_LEVEL_ABBR",
                100, 1, row.buyout or 20000, 0, "PRIVATE_HIGH_BIDDER", "PRIVATE_BIDDER",
                "PRIVATE_OWNER", "PRIVATE_OWNER_FULL", 0, 13463, true
        end,
        GetReplicateItemLink = function(index)
            local row = h.rows[index + 1]
            if row.pending then return nil end
            return row.link or "|cffffffff|Hitem:13463:0:0:0:0:0:0:111:60:0|h[Dreamfoil]|h|r"
        end,
        GetReplicateItemTimeLeft = function() return 4 end,
    }
    local namespace = {}
    for _, name in ipairs({"AuctionLedger.lua", "Tooltip.lua"}) do
        local chunk = assert(loadfile("addon/AuctionLedger/" .. name))
        setfenv(chunk, env); chunk("AuctionLedger", namespace)
    end
    h.env, h.frame = env, h.frames.AuctionLedgerEvents
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
    function h:tooltip(link)
        local tip = {lines = {}, data = {}, link = link}
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
            self:AddDoubleLine("Auctionator Auction", "777c")
            h.tooltipCallback(self, self.data)
        end
        env.GameTooltip = tip; tip:RebuildFromTooltipInfo()
        return tip
    end
    h:event("ADDON_LOADED", "AuctionLedger")
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
streamed.rows[2] = {buyout = 30000}
streamed:event("REPLICATE_ITEM_LIST_UPDATE"); streamed:advance(10)
equal(#streamed.env.AuctionLedgerDB.scans, 0)
streamed:advance(6)
equal(streamed.env.AuctionLedgerDB.scans[1].captured, 2)

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

local notified = harness()
notified.rows = {{}, {pending = true}}
notified:command("scan"); notified:event("REPLICATE_ITEM_LIST_UPDATE")
for _ = 1, 92 do notified:event("REPLICATE_ITEM_LIST_UPDATE"); notified:advance(1) end
equal(notified.env.AuctionLedgerDB.scans[1].captured, 1)
equal(notified.env.AuctionLedgerDB.scans[1].unresolved, 1)
equal(notified.frame.scripts.OnUpdate, nil)

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
local tip = prices:tooltip(baseLink)
equal(#tip.lines, 1) -- No incomplete index is presented as the minimum price.
prices:advance(0.05)
equal(#tip.lines, 3)
equal(tip.lines[1].left, "Auctionator Auction"); equal(tip.lines[1].right, "777c")
assert(tip.lines[2].left:find("ALD Faction / unit", 1, true)); equal(tip.lines[2].right, "1000c")
assert(tip.lines[3].left:find("ALD Neutral / unit", 1, true)); equal(tip.lines[3].right, "500c")
assert(tip.lines[2].left:find("partial", 1, true))
assert(tip.lines[2].left:match("%(%d+m, partial%)"))
prices.tooltipCallback(tip, tip.data); equal(#tip.lines, 3) -- Repeated callbacks do not duplicate lines.
local variantLink = "|Hitem:13463:0:0:0:0:0:-18:1:60:0|h[Different variant]|h"
equal(#prices:tooltip(variantLink).lines, 1) -- A base price is not applied to an unobserved variant.
tip = prices:tooltip(baseLink)
prices.rows = {{buyout = 30000, count = 10}, {pending = true}}
prices:command("scan faction"); prices:event("REPLICATE_ITEM_LIST_UPDATE"); prices:advance(1)
prices:command("save")
equal(#tip.lines, 3); equal(tip.lines[2].right, "3000c"); equal(tip.lines[3].right, "500c") -- Immediate update, no reload/publisher needed.
prices:advance(901); prices.rows = {{buyout = 1, count = 1}}
prices:command("scan faction"); prices:command("cancel")
equal(prices:tooltip(baseLink).lines[2].right, "3000c")

local bigScan = {status = "saved", realm = "Tést Realm", faction = "Alliance", timestamp = 1793534400, coverage = "partial",
    variants = {{itemString = "item:13463"}}, rows = {}}
for n = 1, 3000 do bigScan.rows[n] = "1;1;1000;0;0;0" end
bigScan.rows[3000] = "1;1;5;0;0;0"
local indexed = harness({version = 1, scans = {bigScan}})
tip = indexed:tooltip(baseLink); indexed:advance(0.05); equal(#tip.lines, 1)
indexed:advance(0.2); equal(#tip.lines, 2); equal(tip.lines[2].right, "5c")
tip.link = nil; tip:RebuildFromTooltipInfo(); equal(#tip.lines, 1)

local foreign = harness({version = 1, scans = {{status = "saved", realm = "Other Realm", faction = "Neutral", timestamp = 1793534400,
    variants = {{itemString = "item:13463"}}, rows = {"1;1;1;0;0;0"}},
    {status = "saved", realm = "Tést Realm", faction = "Horde", timestamp = 1793534400,
    variants = {{itemString = "item:13463"}}, rows = {"1;1;1;0;0;0"}}}})
foreign:advance(0.1); equal(#foreign:tooltip(baseLink).lines, 1)

local login = harness({version = 1, scans = {saved}})
login.env.UnitFactionGroup = function() return nil end
login:event("ADDON_LOADED", "AuctionLedger"); login:advance(0.1)
tip = login:tooltip(baseLink); equal(#tip.lines, 1)
login.env.UnitFactionGroup = function() return "Alliance" end
login:event("PLAYER_LOGIN"); login:advance(0.1)
equal(#tip.lines, 2); equal(tip.lines[2].right, "1000c")
login.env.issecretvalue = function(value) return value == baseLink end
tip:RebuildFromTooltipInfo(); equal(#tip.lines, 1)

local variants = harness()
variants.rows = {{}, {link = variantLink, buyout = 10000}}
variants:command("scan"); variants:event("REPLICATE_ITEM_LIST_UPDATE"); variants:advance(16)
equal(variants:tooltip(baseLink).lines[2].right, "1000c")
equal(variants:tooltip(variantLink).lines[2].right, "500c")

local function literal(value)
    if type(value) == "string" then return string.format("%q", value) end
    if type(value) == "number" then return tostring(value) end
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
print("PASS: streaming, metadata, stop-and-save, cooldown, house detection and learning, cross-house retention, item tooltip prices and ages, exact variants, bounded indexing, immediate updates, cancellation and private fields")
