-- Native item tooltip lines coexist with Auctionator and use only ALD's saved scans.
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

local function ageLabel(seconds)
    if seconds < 60 then return "now" end
    if seconds < 3600 then return math.floor(seconds / 60) .. "m" end
    if seconds < 86400 then return math.floor(seconds / 3600) .. "h" end
    return math.floor(seconds / 86400) .. "d"
end
local function appendPrices(tooltip, data)
    if not tooltip.GetItem or not tooltip.AddDoubleLine then return end
    local primary = tooltip.GetPrimaryTooltipData and tooltip:GetPrimaryTooltipData()
    if primary and data and primary ~= data then return end
    local _, link = tooltip:GetItem()
    if (issecretvalue and issecretvalue(link)) or type(link) ~= "string" then return end
    local key = ALD.Variant(link)
    if not key then return end
    -- Native rebuilds clear the lines. Ignore repeated callbacks on an already augmented tooltip.
    local name = tooltip.GetName and tooltip:GetName()
    if name and tooltip.NumLines then
        for line = 1, tooltip:NumLines() do
            local text = _G[name .. "TextLeft" .. line]
            local value = text and text:GetText()
            if type(value) == "string" and not (issecretvalue and issecretvalue(value)) and value:match("^ALD ") then return end
        end
    end
    for _, house in ipairs({UnitFactionGroup("player") or "", "Neutral"}) do
        local entry = cache[house]
        local price = entry and entry.ready and entry.prices[key]
        if price then
            local age = time() - entry.scan.timestamp
            if age >= -300 then
                local label = ("ALD %s / unit (%s, %s)"):format(house == "Neutral" and "Neutral" or "Faction", ageLabel(math.max(0, age)), entry.scan.coverage or "partial")
                local money = GetCoinTextureString and GetCoinTextureString(price) or tostring(price) .. "c"
                tooltip:AddDoubleLine(label, money, 0.85, 0.72, 0.4, 1, 1, 1)
            end
        end
    end
end
if TooltipDataProcessor and TooltipDataProcessor.AddTooltipPostCall and Enum and Enum.TooltipDataType then
    TooltipDataProcessor.AddTooltipPostCall(Enum.TooltipDataType.Item, function(tooltip, data)
        -- Restricted/secret tooltip data must never interfere with the normal item tooltip.
        pcall(appendPrices, tooltip, data)
    end)
end
