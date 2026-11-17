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
    local tooltip = GameTooltip
    if not tooltip or not tooltip:IsShown() or not tooltip.RebuildFromTooltipInfo or not tooltip.GetPrimaryTooltipData
        or (tooltip.IsForbidden and tooltip:IsForbidden()) then return end
    local data = tooltip:GetPrimaryTooltipData()
    if type(data) ~= "table" then return end
    local kind = data.type
    local itemType = Enum and Enum.TooltipDataType and Enum.TooltipDataType.Item
    -- Rebuilding unit/spell tooltips from addon code can pass protected values to Blizzard's handlers.
    if itemType == nil or (issecretvalue and issecretvalue(kind)) or kind ~= itemType then return end
    tooltip:RebuildFromTooltipInfo()
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
            refreshTooltip()
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
    local db, nextCache = AuctionLedgerDB, {}
    if type(db) == "table" and db.version == 1 and type(db.scans) == "table" then
        for index, scan in ipairs(db.scans) do
            local house = type(scan) == "table" and ALD.House(scan.faction)
            if house == "Faction" and scan.status == "saved"
                and type(scan.timestamp) == "number" and type(scan.rows) == "table" and type(scan.variants) == "table" then
                local entry
                for _, previous in ipairs(cache) do if previous.scan == scan then entry = previous; break end end
                if not entry then
                    entry = {scan = scan, prices = {}, keys = {}, index = 1}
                    if scan == saved and observed then
                        for key, price in pairs(observed) do entry.prices[key] = price end
                        roundPrices(entry.prices); entry.ready = true
                    end
                end
                entry.order = index
                nextCache[#nextCache + 1] = entry
            end
        end
    end
    table.sort(nextCache, function(a, b)
        if a.scan.timestamp == b.scan.timestamp then return a.order > b.order end
        return a.scan.timestamp > b.scan.timestamp
    end)
    tasks = {}
    for _, entry in ipairs(nextCache) do if not entry.ready then tasks[#tasks + 1] = entry end end
    cache = nextCache
    worker:SetScript("OnUpdate", #tasks > 0 and indexSavedRows or nil)
    refreshTooltip()
end

local function observedPrice(link)
    if (issecretvalue and issecretvalue(link)) or type(link) ~= "string" then return end
    local key = ALD.Variant(link)
    for _, entry in ipairs(cache) do
        if entry.scan.timestamp <= time() + 300 then
            -- Do not show an older observation while a newer scan is still being indexed.
            if not entry.ready then return end
            local price = key and entry.prices[key]
            if price then
                local epoch = Auctionator.Constants and Auctionator.Constants.SCAN_DAY_0 or 0
                local age = math.max(0, math.floor((time() - epoch) / 86400) - math.floor((entry.scan.timestamp - epoch) / 86400))
                return price, age
            end
        end
    end
end

local context, installedRenderer
local wrapped = setmetatable({}, {__mode = "k"})
local function wrapDatabase(db)
    if not db or type(db.GetFirstPrice) ~= "function" or type(db.GetPriceAge) ~= "function" then return false end
    local seen = wrapped[db]
    if seen and seen.price == db.GetFirstPrice and seen.age == db.GetPriceAge then return true end
    local price, age = db.GetFirstPrice, db.GetPriceAge
    db.GetFirstPrice = function(self, keys, ...)
        if context and context.db == self and context.keys == keys then context.used = true; return context.price end
        return price(self, keys, ...)
    end
    db.GetPriceAge = function(self, key, ...)
        if context and context.used and context.db == self and context.keys[1] == key then return context.age end
        return age(self, key, ...)
    end
    wrapped[db] = {price = db.GetFirstPrice, age = db.GetPriceAge}
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
            local ok, price, age = pcall(observedPrice, link)
            if not ok or type(keys) ~= "table" or #keys == 0 or not wrapDatabase(addon.Database) then
                return render(tooltip, keys, link, count, ...)
            end
            local previous = context
            context = {db = addon.Database, keys = keys, price = price, age = age}
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
