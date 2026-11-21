-- User-triggered, read-only snapshots; no trading or background scans.
local _, ALD = ...
local WAIT, RESOLVE, QUIET, COOLDOWN = 900, 90, 15, 900
-- Conservative storage estimates; keep headroom below the desktop importer's 64 MiB input limit.
local MAX_ROWS, MAX_BYTES, KEEP_BYTES = 500000, 48 * 1024 * 1024, 56 * 1024 * 1024
local events = CreateFrame("Frame", "AuctionLedgerEvents")
local job, window, label, scanButton, neutralButton, autoButton, saveButton, cancelButton
local auctionOpen = false
local elapsedSincePoll = 0
local issuingBrowse, browseHooksInstalled = false, false

local function say(message)
    print("|cffffd100Auction Ledger:|r " .. message)
end

local function status(message)
    if job then job.message = message end
    if label then label:SetText(message) end
end

local function database()
    if not AuctionLedgerDB then AuctionLedgerDB = {version = 1, scans = {}} end
    if AuctionLedgerDB.version ~= 1 or type(AuctionLedgerDB.scans) ~= "table" then
        say("Unknown saved-data version. Previous data was left unchanged.")
        return nil
    end
    return AuctionLedgerDB
end

function ALD.House(faction)
    if faction == "Neutral" then return "Neutral" end
    if faction == "Alliance" or faction == "Horde" or faction == "Faction" then return "Faction" end
end

-- Exact Classic auctioneer identities. Unknown NPCs require a saved manual choice.
local auctioneers = {
    [8661] = "Neutral", [9857] = "Neutral", [9858] = "Neutral", [15677] = "Neutral", [15681] = "Neutral",
    [8669] = "Alliance", [8670] = "Alliance", [8671] = "Alliance", [8719] = "Alliance", [8720] = "Alliance",
    [8723] = "Alliance", [9859] = "Alliance", [15659] = "Alliance", [15678] = "Alliance", [15679] = "Alliance",
    [8672] = "Horde", [8673] = "Horde", [8674] = "Horde", [8721] = "Horde", [8722] = "Horde", [8724] = "Horde",
    [9856] = "Horde", [15675] = "Horde", [15676] = "Horde", [15682] = "Horde", [15683] = "Horde", [15684] = "Horde", [15686] = "Horde",
}
local function auctioneerID()
    if not UnitGUID then return nil end
    local ok, guid = pcall(UnitGUID, "npc")
    if not ok or (issecretvalue and issecretvalue(guid)) or type(guid) ~= "string" then return nil end
    return tonumber(guid:match("^Creature%-[^%-]+%-[^%-]+%-[^%-]+%-[^%-]+%-(%d+)%-"))
end
local function detectHouse()
    if not auctionOpen then return nil end
    local id, db = auctioneerID(), database()
    local remembered = id and db and type(db.auctioneers) == "table" and db.auctioneers[id]
    if remembered == "Faction" then return UnitFactionGroup("player"), "remembered choice" end
    if remembered == "Neutral" then return "Neutral", "remembered choice" end
    return auctioneers[id], "auctioneer identity"
end
local function readyWindow()
    if not autoButton or job then return end
    local house, source = detectHouse()
    if house then autoButton:Enable() else autoButton:Disable() end
    if not auctionOpen then status("Open the Auction House to detect its house.")
    elseif house then status(("Detected: %s AH (%s).\nScan current uses this house. Manual buttons override it.\nAfter saving: /reload, then run the desktop publisher."):format(house, source))
    else status("Auctioneer not recognized. Choose Faction or Neutral.\nALD remembers this auctioneer after a saved manual scan.\nAfter saving: /reload, then run the desktop publisher.") end
end

-- Remove per-instance unique ID, viewer level and specialization. Preserve enchant,
-- gems, suffix, difficulty, bonuses and remaining modifiers; do not collapse variants.
local function variant(link)
    local payload = type(link) == "string" and (link:match("|H(item:[%d:%-]+)|h") or link:match("^(item:[%d:%-]+)$"))
    if not payload then return nil end
    local fields = {}
    for field in (payload .. ":"):gmatch("(.-):") do
        fields[#fields + 1] = field == "" and "0" or field
    end
    for _, index in ipairs({9, 10, 11}) do if fields[index] then fields[index] = "0" end end
    while #fields > 2 and fields[#fields] == "0" do fields[#fields] = nil end
    return table.concat(fields, ":")
end
ALD.Variant = variant

function ALD.BrowseKey(key)
    if type(key) ~= "table" then return nil end
    local fields = {key.itemID, key.itemLevel or 0, key.itemSuffix or 0, key.battlePetSpeciesID or 0}
    for i, value in ipairs(fields) do
        if type(value) ~= "number" or value % 1 ~= 0 or math.abs(value) > 1e9 or (i ~= 3 and value < 0) then return nil end
    end
    if not fields[1] or fields[1] < 1 then return nil end
    return ("browse:%d:%d:%d:%d"):format(unpack(fields))
end

local function finish(reason, save)
    local current = job
    if not current then return end
    job = nil
    events:SetScript("OnUpdate", nil)
    if scanButton then scanButton:Enable(); neutralButton:Enable(); saveButton:Disable(); saveButton:SetText("Stop and Save"); cancelButton:Disable(); readyWindow() end
    local db = database()
    if not db then return end
    db.lastAttempt = {timestamp = time(), faction = current.faction, status = save and "saved" or "stopped", message = reason}
    if save and #current.rows > 0 then
        local version, build, _, interface = GetBuildInfo()
        local scan = {
            status = "saved", startedAt = current.startedAt, timestamp = time(),
            realm = GetRealmName(), faction = current.faction, coverage = "partial",
            captureComplete = #current.rows == current.total and (current.api ~= "browse" or current.browseComplete == true),
            api = current.api, gameVersion = version, build = build, interface = interface,
            reason = reason, received = current.total, captured = #current.rows,
            unresolved = current.total - #current.rows,
            unread = math.max(0, current.total - current.nextRow),
            pendingItemData = current.pendingCounts.item, pendingAuctionData = current.pendingCounts.details,
            estimatedBytes = current.bytes, variants = current.variants, rows = current.rows,
        }
        db.scans[#db.scans + 1] = scan
        if current.manual and current.auctioneer then
            if type(db.auctioneers) ~= "table" then db.auctioneers = {} end
            db.auctioneers[current.auctioneer] = current.manual
        end
        local bytes = 0
        for _, saved in ipairs(db.scans) do bytes = bytes + (saved.estimatedBytes or KEEP_BYTES) end
        while #db.scans > 1 and (#db.scans > 3 or bytes > KEEP_BYTES) do
            -- Prefer replacing an older scan of the same house, keeping the other house available.
            local remove = 1
            for i = 1, #db.scans - 1 do
                local duplicate = false
                for j = i + 1, #db.scans do
                    if ALD.House(db.scans[i].faction) == ALD.House(db.scans[j].faction) then duplicate = true; break end
                end
                if duplicate then remove = i; break end
            end
            bytes = bytes - (db.scans[remove].estimatedBytes or KEEP_BYTES)
            table.remove(db.scans, remove)
        end
        if ALD.RefreshPrices then ALD.RefreshPrices(scan, current.prices) end
        if autoButton then if detectHouse() then autoButton:Enable() else autoButton:Disable() end end
        local message = ("%s AH: %s\nSaved %d / %d returned %s (%d unresolved).\n%s\nUse /reload, then run the desktop publisher."):format(ALD.House(scan.faction), scan.captureComplete and "Capture complete." or "Partial capture saved.", #scan.rows, scan.received, scan.api == "browse" and "item groups" or "rows", scan.unresolved, reason)
        status(message); say(message:gsub("\n", " "))
    else
        status(reason .. "\nPrevious scans kept.")
        say(reason .. " Previous scans kept.")
    end
end

local function stopAndSave()
    if not job then say("No scan is running."); return end
    if #job.rows == 0 then
        say("No rows captured yet. The scan is still running; Cancel discards it.")
        return
    end
    if job.api == "browse" then finish("Browse summary saved by user; prices and quantities only", true); return end
    local total = C_AuctionHouse.GetNumReplicateItems() or 0
    if total < job.total then finish("The replicate list changed during capture; scan again later.", false); return end
    job.total = total
    finish(#job.rows == total and "All returned rows captured; saved by user" or "Stopped early by user", true)
end

local function browseAvailable()
    local api = C_AuctionHouse
    return api and api.SendBrowseQuery and api.GetBrowseResults and api.HasFullBrowseResults
        and api.RequestMoreBrowseResults and api.IsThrottledMessageSystemReady
end

local function beginBrowse()
    job.api, job.browseBegan, job.browseLastResponse = "browse", GetTime(), GetTime()
    job.browseWaiting, job.browseSent, job.browseIndex = false, false, 1
    if not browseHooksInstalled and hooksecurefunc then
        browseHooksInstalled = true
        for _, method in ipairs({"SendBrowseQuery", "SearchForFavorites", "SearchForItemKeys", "SendSearchQuery", "SendSellSearchQuery"}) do
            if type(C_AuctionHouse[method]) == "function" then
                hooksecurefunc(C_AuctionHouse, method, function()
                    if job and job.api == "browse" and not issuingBrowse then
                        finish("Another auction search interrupted the browse scan; captured item groups kept", #job.rows > 0)
                    end
                end)
            end
        end
    end
    status(ALD.House(job.faction) .. " AH: starting browse summary…\nPrices and listed quantities; no auction counts or median.\nKeep the AH open and leave other searches idle.")
end

local function browseStep(now)
    local api = C_AuctionHouse
    if now - job.browseLastResponse > 60 or now - job.browseBegan > WAIT then
        finish("Browse response timed out; captured item groups kept", #job.rows > 0); return
    end
    if job.browseResults then
        local began = debugprofilestop and debugprofilestop() or 0
        for _ = 1, 400 do
            local result = job.browseResults[job.browseIndex]
            if not result then break end
            job.browseIndex = job.browseIndex + 1
            local key = ALD.BrowseKey(result.itemKey)
            local quantity, price = result.totalQuantity, result.minPrice
            if key and type(quantity) == "number" and quantity >= 0 and quantity <= 1e9 and quantity % 1 == 0
                and type(price) == "number" and price >= 0 and price <= 1e14 and price % 1 == 0 then
                local id = job.byVariant[key]
                if not id and quantity > 0 and price > 0 then
                    id = #job.variants + 1; job.byVariant[key] = id
                    local source = result.itemKey
                    local info = api.GetItemKeyInfo and api.GetItemKeyInfo(source)
                    local itemClass
                    local instant = C_Item and C_Item.GetItemInfoInstant or GetItemInfoInstant
                    if instant then local _, _, _, _, _, classID = instant(source.itemID); itemClass = classID end
                    job.variants[id] = {itemId = source.itemID, name = info and info.itemName,
                        quality = info and info.quality, classID = itemClass,
                        browseKey = {itemID = source.itemID, itemLevel = source.itemLevel or 0,
                            itemSuffix = source.itemSuffix or 0, battlePetSpeciesID = source.battlePetSpeciesID or 0}}
                    job.bytes = job.bytes + #key + #(info and info.itemName or "") + 1024
                end
                if id then
                    -- Each row is a group observation, not a made-up auction or stack.
                    job.rows[id] = ("%d;%d;%.0f"):format(id, quantity, price)
                    job.total = math.max(job.total, #job.rows)
                    job.prices[key] = quantity > 0 and price > 0 and price or nil
                    if saveButton then saveButton:Enable() end
                end
            end
            if #job.rows >= 100000 or job.bytes > MAX_BYTES then
                finish("Browse storage budget reached; captured item groups kept", #job.rows > 0); return
            end
            if debugprofilestop and debugprofilestop() - began > 3 then break end
        end
        if job.browseIndex > #job.browseResults then
            job.browseResults = nil
            if api.HasFullBrowseResults() then
                job.browseComplete = true
                finish("Browse summary complete; prices and quantities only", #job.rows > 0); return
            end
        end
    end
    if not job.browseResults and not job.browseWaiting and api.IsThrottledMessageSystemReady() then
        job.browseWaiting = true
        local first = not job.browseSent
        job.browseSent = true
        issuingBrowse = true
        local ok, message
        if first then ok, message = pcall(api.SendBrowseQuery, {searchString = "", sorts = {}, filters = {}, itemClassFilters = {}})
        else ok, message = pcall(api.RequestMoreBrowseResults) end
        issuingBrowse = false
        if not job then return end
        if not ok then finish("Browse request failed: " .. tostring(message), #job.rows > 0); return end
    end
    status(("%s AH: browse summary, %d item groups captured\nElapsed: %ds · waiting for %s\nPrices and quantities only. Stop and Save keeps captured data."):format(ALD.House(job.faction), #job.rows, math.floor(now - job.browseBegan), job.browseResults and "cataloging" or "the next page"))
end

local function pendingRow(index, reason, itemID)
    local previous = job.pending[index]
    if previous ~= reason then
        if previous then job.pendingCounts[previous] = job.pendingCounts[previous] - 1 end
        job.pendingCounts[reason] = job.pendingCounts[reason] + 1
        job.pending[index] = reason
    end
    if type(itemID) ~= "number" or itemID < 1 then return end
    local indices = job.byItem[itemID]
    if not indices then indices = {}; job.byItem[itemID] = indices end
    indices[index] = true
    if not job.requested[itemID] and (job.attempts[itemID] or 0) < 3 and C_Item and C_Item.RequestLoadItemDataByID then
        job.requested[itemID] = true
        job.attempts[itemID] = (job.attempts[itemID] or 0) + 1
        local ok = pcall(C_Item.RequestLoadItemDataByID, itemID)
        if not ok then job.requested[itemID] = nil end
    end
end

local function readRow(index)
    local api = C_AuctionHouse
    local name, texture, count, quality, usable, level, levelType, minBid, increment,
        buyout, bid, highBidder, bidder, owner, ownerFullName, saleStatus, itemID = api.GetReplicateItemInfo(index)
    -- Names of sellers/bidders are never put in any table or SavedVariables.
    local key = variant(api.GetReplicateItemLink(index))
    local linkID = key and tonumber(key:match("^item:(%d+)"))
    if type(itemID) ~= "number" or itemID < 1 then itemID = linkID end
    if not key then return false, "item", itemID end
    if not linkID or linkID < 1 or linkID > 1e9 or linkID ~= itemID or #key > 2048
        or type(count) ~= "number" or count < 1 or count > 1e9 or count % 1 ~= 0
        or type(buyout) ~= "number" or buyout < 0 or buyout > 1e14 or buyout % 1 ~= 0 then return false, "details", itemID end
    local id = job.byVariant[key]
    if not id then
        local itemClass
        local getInstant = C_Item and C_Item.GetItemInfoInstant or GetItemInfoInstant
        if getInstant then
            local _, _, _, _, _, classID = getInstant(itemID)
            itemClass = classID
        end
        id = #job.variants + 1
        job.byVariant[key] = id
        job.variants[id] = {itemId = itemID, itemString = key, name = name,
            quality = quality and quality >= 0 and quality or nil, classID = itemClass}
        job.bytes = job.bytes + #key + #(name or "") + 512
    end
    local timeLeft = api.GetReplicateItemTimeLeft and api.GetReplicateItemTimeLeft(index) or 0
    -- Compact numeric strings keep large SavedVariables well below the import limit.
    -- variant;stack quantity;whole-stack buyout;minimum bid;current bid;time-left band
    local row = ("%d;%d;%.0f;%.0f;%.0f;%d"):format(id, count, buyout, minBid or 0, bid or 0, timeLeft or 0)
    job.rows[#job.rows + 1] = row
    if buyout > 0 then job.prices[key] = math.min(job.prices[key] or math.huge, buyout / count) end
    if saveButton and #job.rows == 1 then saveButton:Enable() end
    job.bytes = job.bytes + #row + 64
    local reason = job.pending[index]
    if reason then job.pendingCounts[reason] = job.pendingCounts[reason] - 1; job.pending[index] = nil end
    return true
end

local function step()
    local now = GetTime()
    local id = auctioneerID()
    if id and job.auctioneer and id ~= job.auctioneer then finish("Auctioneer changed during capture", false); return end
    if job.api == "browse" then browseStep(now); return end
    if not job.gotEvent then
        if now - job.began >= 45 and browseAvailable() then
            say("No full-list response. Switching to a browse summary of prices and quantities.")
            beginBrowse(); return
        end
        if now - job.began > WAIT then finish("No replicate response. The server may be on its full-scan cooldown.", false) end
        return
    end
    local total = C_AuctionHouse.GetNumReplicateItems() or 0
    if total < job.total then finish("The replicate list changed during capture; scan again later.", false); return end
    if total > MAX_ROWS then
        job.total = total
        finish("Returned list exceeds 500,000 rows; captured rows kept as a partial scan", #job.rows > 0); return
    end
    if total > job.total then
        -- Replicate indices are zero-based. Newly streamed rows join the current pass.
        job.total, job.lastGrowth, job.tailSince = total, now, nil
    end
    if total == 0 then
        if now - job.began > WAIT then finish("No auction rows returned.", false) end
        return
    end
    local began = debugprofilestop and debugprofilestop() or 0
    local processed = 0
    while processed < 400 do
        local index, retry, fresh
        if job.urgentCursor <= #job.urgent then
            index = job.urgent[job.urgentCursor]
            job.urgentCursor = job.urgentCursor + 1; job.urgentQueued[index] = nil
        elseif job.nextRow < total then
            index, fresh, retry = job.nextRow, true, true
            job.nextRow = job.nextRow + 1
        elseif now >= job.nextPass and job.cursor <= #job.queue then
            index, retry = job.queue[job.cursor], true
            job.cursor = job.cursor + 1
        else break end
        if fresh or job.pending[index] then
            local captured, reason, itemID = readRow(index)
            if not captured then
                pendingRow(index, reason, itemID)
                if retry then job.retry[#job.retry + 1] = index end
            end
        end
        processed = processed + 1
        if job.bytes > MAX_BYTES then
            finish("Scan storage budget reached; captured rows kept as a partial scan", #job.rows > 0); return
        end
        if debugprofilestop and debugprofilestop() - began > 3 then break end
    end
    if job.urgentCursor > #job.urgent then job.urgent, job.urgentCursor = {}, 1 end
    if job.cursor > #job.queue then
        job.queue, job.retry, job.cursor, job.nextPass = job.retry, {}, 1, now + 1
    end
    if job.nextRow >= total and not job.tailSince then job.tailSince = now end
    if #job.rows == total and now - job.lastGrowth >= QUIET then
        -- No end-of-stream flag exists: a quiet list is still marked partial.
        finish("All returned rows captured; list settled", true); return
    end
    -- A trickle of resolved rows must not keep the entire retry phase alive indefinitely.
    if #job.rows < total and job.tailSince and now - job.tailSince >= RESOLVE then
        finish("Item-data retry budget reached; unresolved rows omitted", #job.rows > 0); return
    end
    if now - job.began > WAIT + RESOLVE then finish("Capture time budget reached; captured rows kept", #job.rows > 0); return end
    if saveButton then saveButton:SetText(#job.rows == total and "Save now" or "Stop and Save") end
    if #job.rows == total then
        status(("%s AH: cataloging complete (%d / %d rows).\nChecking for more rows: autosave in %ds.\nSave now keeps all captured rows."):format(ALD.House(job.faction), #job.rows, total, math.max(0, math.ceil(QUIET - (now - job.lastGrowth)))))
    else
        status(("%s AH: captured %d / %d rows\nWaiting: %d item data; %d auction details\n%s\nStop and Save keeps captured rows."):format(ALD.House(job.faction), #job.rows, total, job.pendingCounts.item, job.pendingCounts.details,
            job.nextRow < total and ("Reading %d more returned rows"):format(total - job.nextRow) or ("Resolving remaining data: up to %ds"):format(math.max(0, math.ceil(RESOLVE - (now - job.tailSince))))))
    end
end

local function start(mode, browse)
    if job then say("A scan is already running."); return end
    if not auctionOpen then say("Open the Auction House first."); return end
    local api = C_AuctionHouse
    local replicate = api and api.ReplicateItems and api.GetNumReplicateItems and api.GetReplicateItemInfo and api.GetReplicateItemLink
    if not replicate and not browseAvailable() then
        say("This client does not expose the required replicate API."); return
    end
    local db = database()
    if not db then return end
    local faction
    if mode == "Neutral" then faction = "Neutral"
    elseif mode == "Faction" then faction = UnitFactionGroup("player")
    else faction = detectHouse() end
    if faction ~= "Alliance" and faction ~= "Horde" and faction ~= "Neutral" then
        say("House not detected. Choose Scan Faction AH or Scan Neutral AH; a saved manual scan teaches this auctioneer."); return
    end
    local remaining = COOLDOWN - (time() - math.max(db.lastResponseAt or 0, db.lastRequestAt or 0))
    browse = browse or not replicate or remaining > 0
    if browse and not browseAvailable() then
        say(remaining > 0 and ("Full-scan cooldown: about %d more seconds."):format(remaining) or "This client does not expose the browse API."); return
    end
    local now = GetTime()
    job = {startedAt = time(), began = now, faction = faction, auctioneer = auctioneerID(), manual = mode,
        api = "replicate", gotEvent = false, lastGrowth = now,
        total = 0, nextRow = 0, cursor = 1, urgentCursor = 1, nextPass = 0, bytes = 1024,
        queue = {}, retry = {}, urgent = {}, urgentQueued = {}, pending = {}, byItem = {},
        pendingCounts = {item = 0, details = 0}, attempts = {},
        variants = {}, rows = {}, byVariant = {}, requested = {}, prices = {}}
    elapsedSincePoll = 0
    if scanButton then scanButton:Disable(); neutralButton:Disable(); autoButton:Disable(); saveButton:Disable(); saveButton:SetText("Stop and Save"); cancelButton:Enable() end
    status(faction .. " AH: waiting for the server's auction list…\nThis can take several minutes. Keep the AH open.")
    say(faction .. " AH scan requested. This reads the currently open AH; make sure you chose the matching house.")
    events:SetScript("OnUpdate", function(_, elapsed)
        elapsedSincePoll = elapsedSincePoll + elapsed
        if elapsedSincePoll < 0.05 then return end
        elapsedSincePoll = 0
        local ok, message = pcall(step)
        if not ok then finish("Capture error: " .. tostring(message), false) end
    end)
    if browse then beginBrowse(); return end
    local ok, message = pcall(api.ReplicateItems)
    if ok then db.lastRequestAt = time()
    elseif browseAvailable() then beginBrowse()
    else finish("Request failed: " .. tostring(message), false) end
end

local function showWindow()
    if not window then
        window = CreateFrame("Frame", "AuctionLedgerWindow", UIParent, "BasicFrameTemplateWithInset")
        window:SetSize(380, 232); window:SetPoint("CENTER"); window:SetClampedToScreen(true)
        window:SetMovable(true); window:EnableMouse(true); window:RegisterForDrag("LeftButton")
        window:SetScript("OnDragStart", window.StartMoving)
        window:SetScript("OnDragStop", window.StopMovingOrSizing)
        window.TitleText:SetText("Auction Ledger Scanner")
        label = window:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
        label:SetPoint("TOPLEFT", 16, -40); label:SetSize(348, 96); label:SetJustifyH("LEFT")
        label:SetText("Open the matching Auction House, then choose its scan button.\nFaction and Neutral are saved separately.\nAfter saving: /reload, then run the desktop publisher.")
        scanButton = CreateFrame("Button", "AuctionLedgerFactionButton", window, "UIPanelButtonTemplate")
        scanButton:SetSize(168, 26); scanButton:SetPoint("BOTTOMLEFT", 16, 52); scanButton:SetText("Scan Faction AH")
        scanButton:SetScript("OnClick", function() start("Faction") end)
        neutralButton = CreateFrame("Button", "AuctionLedgerNeutralButton", window, "UIPanelButtonTemplate")
        neutralButton:SetSize(168, 26); neutralButton:SetPoint("BOTTOMRIGHT", -16, 52); neutralButton:SetText("Scan Neutral AH")
        neutralButton:SetScript("OnClick", function() start("Neutral") end)
        autoButton = CreateFrame("Button", "AuctionLedgerAutoButton", window, "UIPanelButtonTemplate")
        autoButton:SetSize(98, 26); autoButton:SetPoint("BOTTOMLEFT", 16, 16); autoButton:SetText("Scan current")
        autoButton:SetScript("OnClick", function() start() end)
        saveButton = CreateFrame("Button", "AuctionLedgerSaveButton", window, "UIPanelButtonTemplate")
        saveButton:SetSize(98, 26); saveButton:SetPoint("BOTTOM", 0, 16); saveButton:SetText("Stop and Save")
        saveButton:Disable(); saveButton:SetScript("OnClick", stopAndSave)
        cancelButton = CreateFrame("Button", nil, window, "UIPanelButtonTemplate")
        cancelButton:SetSize(98, 26); cancelButton:SetPoint("BOTTOMRIGHT", -16, 16); cancelButton:SetText("Cancel")
        cancelButton:Disable(); cancelButton:SetScript("OnClick", function() finish("Cancelled", false) end)
    end
    readyWindow()
    window:Show()
end

local function addScanButton()
    if not AuctionHouseFrame or AuctionLedgerAHScanButton then return end
    local button = CreateFrame("Button", "AuctionLedgerAHScanButton", AuctionHouseFrame, "UIPanelButtonTemplate")
    button:SetSize(88, 24)
    button:SetText("Scan")
    button:SetPoint("BOTTOMRIGHT", AuctionHouseFrame, "BOTTOMRIGHT", -20, -28)
    button:SetScript("OnClick", showWindow)
end

events:RegisterEvent("ADDON_LOADED")
events:RegisterEvent("PLAYER_LOGIN")
events:RegisterEvent("AUCTION_HOUSE_SHOW")
events:RegisterEvent("AUCTION_HOUSE_CLOSED")
events:RegisterEvent("REPLICATE_ITEM_LIST_UPDATE")
events:RegisterEvent("AUCTION_HOUSE_BROWSE_RESULTS_UPDATED")
events:RegisterEvent("AUCTION_HOUSE_BROWSE_RESULTS_ADDED")
events:RegisterEvent("AUCTION_HOUSE_BROWSE_FAILURE")
events:RegisterEvent("AUCTION_HOUSE_DISABLED")
pcall(events.RegisterEvent, events, "ITEM_DATA_LOAD_RESULT")
events:SetScript("OnEvent", function(_, event, name, success)
    if event == "ADDON_LOADED" then
        addScanButton()
        if name == "AuctionLedger" then database(); if ALD.RefreshPrices then ALD.RefreshPrices() end end
        if name == "Auctionator" and ALD.InstallAuctionatorBridge then ALD.InstallAuctionatorBridge() end
    elseif event == "PLAYER_LOGIN" then addScanButton(); if ALD.RefreshPrices then ALD.RefreshPrices() end
    elseif event == "AUCTION_HOUSE_SHOW" then
        auctionOpen = true; addScanButton(); readyWindow(); if ALD.RefreshAuctionator then ALD.RefreshAuctionator() end
    elseif event == "AUCTION_HOUSE_DISABLED" then finish("Auction House disabled during capture", false)
    elseif event == "AUCTION_HOUSE_CLOSED" then
        auctionOpen = false; finish("Auction House closed during capture", false); readyWindow(); if ALD.RefreshAuctionator then ALD.RefreshAuctionator() end
    elseif event == "ITEM_DATA_LOAD_RESULT" and job and type(name) == "number" then
        job.requested[name] = nil
        if success then
            for index in pairs(job.byItem[name] or {}) do
                if job.pending[index] and not job.urgentQueued[index] then
                    job.urgent[#job.urgent + 1] = index; job.urgentQueued[index] = true
                end
            end
        end
    elseif job and job.api == "browse" and event == "AUCTION_HOUSE_BROWSE_FAILURE" then
        finish("Server rejected the browse query; captured item groups kept", #job.rows > 0)
    elseif job and job.api == "browse" and job.browseSent
        and (event == "AUCTION_HOUSE_BROWSE_RESULTS_UPDATED" or event == "AUCTION_HOUSE_BROWSE_RESULTS_ADDED") then
        job.browseResults = C_AuctionHouse.GetBrowseResults()
        job.total = math.max(job.total, #job.browseResults)
        job.browseIndex, job.browseWaiting, job.browseLastResponse = 1, false, GetTime()
    elseif event == "REPLICATE_ITEM_LIST_UPDATE" and job and job.api == "replicate" then
        if not job.gotEvent then
            local db = database()
            if db then db.lastResponseAt = time() end
        end
        job.gotEvent = true
    end
end)

SLASH_AUCTIONLEDGER1 = "/ald"
SlashCmdList.AUCTIONLEDGER = function(command)
    local action = (command or ""):lower():match("^%s*(.-)%s*$")
    if action == "scan" or action == "scan faction" or action == "scan neutral" then
        showWindow(); start(action == "scan neutral" and "Neutral" or action == "scan faction" and "Faction" or nil)
    elseif action == "browse" or action == "browse faction" or action == "browse neutral" then
        showWindow(); start(action == "browse neutral" and "Neutral" or action == "browse faction" and "Faction" or nil, true)
    elseif action == "save" then stopAndSave()
    elseif action == "cancel" then finish("Cancelled", false)
    elseif action == "status" then
        local db = database()
        if db then say(job and job.message:gsub("\n", " ") or ("%d saved scan(s). %s"):format(#db.scans, db.lastAttempt and ((ALD.House(db.lastAttempt.faction) or "") .. " " .. db.lastAttempt.message) or "No scan attempted.")) end
    else showWindow(); say("/ald scan faction · /ald scan neutral · /ald save · /ald cancel · /ald status") end
end
