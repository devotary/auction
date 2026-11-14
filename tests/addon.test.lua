-- Exercise the real addon with a small mocked WoW event loop (Lua 5.1).
local function equal(actual, expected)
    assert(actual == expected, tostring(actual) .. " ~= " .. tostring(expected))
end
local function harness(previous)
    local h = {clock = 0, frames = {}, rows = {}, requests = 0, reads = 0, loads = 0, messages = {}}
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
    local chunk = assert(loadfile("addon/AuctionLedger/AuctionLedger.lua"))
    setfenv(chunk, env); chunk()
    h.env, h.frame = env, h.frames.AuctionLedgerEvents
    function h:event(name, ...) self.frame.scripts.OnEvent(self.frame, name, ...) end
    function h:command(text) self.env.SlashCmdList.AUCTIONLEDGER(text) end
    function h:advance(seconds)
        for _ = 1, math.ceil(seconds / 0.05) do
            self.clock = self.clock + 0.05
            local update = self.frame.scripts.OnUpdate
            if update then update(self.frame, 0.05) end
        end
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
neutral.rows = {{}}
neutral:command("scan neutral"); neutral:event("REPLICATE_ITEM_LIST_UPDATE"); neutral:advance(16)
equal(neutral.env.AuctionLedgerDB.scans[1].faction, "Neutral")

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
print("PASS: streaming, delayed metadata, stalled cache events, stop-and-save button/command, empty saves, zero-based batches, cooldown, repeat scans, cancellation, AH close, timeout, changed list, request failure, retention and private fields")
