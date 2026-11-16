-- Supply saved ALD observations to Auctionator's existing item tooltip renderer.
local _, ALD = ...
local cache, tasks = {}, {}
local worker = CreateFrame("Frame", "AuctionLedgerPrices")

local function roundPrices(prices)
    for key, price in pairs(prices) do
        local rounded = math.floor(price + 0.5)
        prices[key] = rounded > 0 and rounded or nil
    end
end
local function refreshTooltip()
    if GameTooltip and GameTooltip:IsShown() and GameTooltip.RebuildFromTooltipInfo then
        GameTooltip:RebuildFromTooltipInfo()
    end
end
ALD.RefreshAuctionator = refreshTooltip
local function indexSavedRows()
    local began = debugprofilestop and debugprofilestop() or 0
    for _ = 1, 1000 do
        local task = tasks[1]
        if not task then worker:SetScript("OnUpdate", nil); refreshTooltip(); return end
        local row = task.scan.rows[task.index]
        if row == nil then
            roundPrices(task.prices); task.ready = true; task.keys = nil; table.remove(tasks, 1)
        else
            task.index = task.index + 1
            if type(row) == "string" then
                local id, count, buyout = row:match("^(%d+);(%d+);(%d+);")
                id, count, buyout = tonumber(id), tonumber(count), tonumber(buyout)
                local key = id and task.keys[id]
                if id and key == nil then
                    local meta = task.scan.variants[id]
                    key = type(meta) == "table" and ALD.Variant(meta.itemString)
                    task.keys[id] = key or false
                end
                if key and count and count > 0 and buyout and buyout > 0 then
                    task.prices[key] = math.min(task.prices[key] or math.huge, buyout / count)
                end
            end
        end
        if debugprofilestop and debugprofilestop() - began > 3 then return end
    end
end

function ALD.RefreshPrices(saved, observed)
    if ALD.InstallAuctionatorBridge then ALD.InstallAuctionatorBridge() end
    local db, latest, nextCache = AuctionLedgerDB, {}, {}
    local faction, realm = UnitFactionGroup("player"), GetRealmName()
    if type(db) == "table" and db.version == 1 and type(db.scans) == "table" then
        for _, scan in ipairs(db.scans) do
            if type(scan) == "table" and scan.status == "saved" and scan.realm == realm and (scan.faction == "Neutral" or (faction and scan.faction == faction))
                and type(scan.timestamp) == "number" and type(scan.rows) == "table" and type(scan.variants) == "table" then
                local old = latest[scan.faction]
                if not old or scan.timestamp >= old.timestamp then latest[scan.faction] = scan end
            end
        end
    end
    tasks = {}
    for house, scan in pairs(latest) do
        local entry = cache[house]
        if not entry or entry.scan ~= scan or not entry.ready then
            entry = {scan = scan, prices = {}, keys = {}, index = 1}
            if scan == saved and observed then
                for key, price in pairs(observed) do entry.prices[key] = price end
                roundPrices(entry.prices); entry.ready = true
            else tasks[#tasks + 1] = entry end
        end
        nextCache[house] = entry
    end
    cache = nextCache
    worker:SetScript("OnUpdate", #tasks > 0 and indexSavedRows or nil)
    refreshTooltip()
end

local function observedPrice(link)
    local house = ALD.CurrentHouse()
    if (issecretvalue and issecretvalue(link)) or type(link) ~= "string" then return end
    local key = ALD.Variant(link)
    local entry = cache[house]
    local price = entry and entry.ready and key and entry.prices[key]
    if price and entry.scan.timestamp <= time() + 300 then
        local epoch = Auctionator.Constants and Auctionator.Constants.SCAN_DAY_0 or 0
        local age = math.max(0, math.floor((time() - epoch) / 86400) - math.floor((entry.scan.timestamp - epoch) / 86400))
        return price, age, house
    end
    return nil, nil, house
end

local context, installedRenderer
local wrapped = setmetatable({}, {__mode = "k"})
local function wrapDatabase(db)
    if not db or type(db.GetFirstPrice) ~= "function" or type(db.GetPriceAge) ~= "function" then return false end
    local seen = wrapped[db]
    if seen and seen.price == db.GetFirstPrice and seen.age == db.GetPriceAge and seen.mean == db.GetMeanPrice then return true end
    local price, age, mean = db.GetFirstPrice, db.GetPriceAge, db.GetMeanPrice
    db.GetFirstPrice = function(self, keys, ...)
        if context and context.db == self and context.keys == keys then context.used = true; return context.price end
        return price(self, keys, ...)
    end
    db.GetPriceAge = function(self, key, ...)
        if context and context.used and context.db == self and context.keys[1] == key then return context.age end
        return age(self, key, ...)
    end
    if type(mean) == "function" then
        db.GetMeanPrice = function(self, key, ...)
            if context and context.used and context.db == self and context.house == "Neutral" and context.keys[1] == key then return nil end
            return mean(self, key, ...)
        end
    end
    wrapped[db] = {price = db.GetFirstPrice, age = db.GetPriceAge, mean = db.GetMeanPrice}
    return true
end
local function restore(previous, ok, ...)
    context = previous
    if not ok then error((...), 0) end
    return ...
end
function ALD.InstallAuctionatorBridge()
    local addon = Auctionator
    local render = addon and addon.Tooltip and addon.Tooltip.ShowTipWithPricingDBKey
    if type(render) ~= "function" then return end
    if render ~= installedRenderer then
        installedRenderer = function(tooltip, keys, link, count, ...)
            local ok, price, age, house = pcall(observedPrice, link)
            if not ok or type(keys) ~= "table" or #keys == 0 or (not price and house ~= "Neutral") or not wrapDatabase(addon.Database) then
                return render(tooltip, keys, link, count, ...)
            end
            local previous = context
            context = {db = addon.Database, keys = keys, price = price, age = age, house = house}
            return restore(previous, pcall(render, tooltip, keys, link, count, ...))
        end
        addon.Tooltip.ShowTipWithPricingDBKey = installedRenderer
    end
    -- Normal hover is one unit; Shift uses Auctionator's native stack/vendor calculation.
    local config = addon.Config
    local option = config and config.Options and config.Options.SHIFT_STACK_TOOLTIPS
    if option and config.Set and config.Get then
        local ok, enabled = pcall(config.Get, option)
        if ok and not enabled then pcall(config.Set, option, true) end
    end
end
