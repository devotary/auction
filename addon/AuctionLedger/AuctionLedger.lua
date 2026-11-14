-- One user-triggered replicate request; no trading, hooks, libraries or background scans.
local WAIT, RESOLVE, QUIET, COOLDOWN = 900, 90, 15, 900
local MAX_ROWS, MAX_BYTES, KEEP_BYTES = 250000, 24 * 1024 * 1024, 40 * 1024 * 1024
local events = CreateFrame("Frame", "AuctionLedgerEvents")
local job, window, label, scanButton, saveButton, cancelButton
local auctionOpen = false
local elapsedSincePoll = 0

local function say(message)
    print("|cffffd100Auction Ledger:|r " .. message)
end

local function status(message)
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

-- Remove per-instance unique ID, viewer level and specialization. Preserve enchant,
-- gems, suffix, difficulty, bonuses and remaining modifiers; do not collapse variants.
local function variant(link)
    local payload = type(link) == "string" and link:match("|H(item:[%d:%-]+)|h")
    if not payload then return nil end
    local fields = {}
    for field in (payload .. ":"):gmatch("(.-):") do
        fields[#fields + 1] = field == "" and "0" or field
    end
    for _, index in ipairs({9, 10, 11}) do if fields[index] then fields[index] = "0" end end
    while #fields > 2 and fields[#fields] == "0" do fields[#fields] = nil end
    return table.concat(fields, ":")
end

local function finish(reason, save)
    local current = job
    if not current then return end
    job = nil
    events:SetScript("OnUpdate", nil)
    if scanButton then scanButton:Enable(); saveButton:Disable(); cancelButton:Disable() end
    local db = database()
    if not db then return end
    db.lastAttempt = {timestamp = time(), status = save and "saved" or "stopped", message = reason}
    if save and #current.rows > 0 then
        local version, build, _, interface = GetBuildInfo()
        local scan = {
            status = "saved", startedAt = current.startedAt, timestamp = time(),
            realm = GetRealmName(), faction = current.faction, coverage = "partial",
            api = "replicate", gameVersion = version, build = build, interface = interface,
            reason = reason, received = current.total, captured = #current.rows,
            unresolved = current.total - #current.rows,
            estimatedBytes = current.bytes, variants = current.variants, rows = current.rows,
        }
        db.scans[#db.scans + 1] = scan
        local bytes = 0
        for _, saved in ipairs(db.scans) do bytes = bytes + (saved.estimatedBytes or KEEP_BYTES) end
        while #db.scans > 1 and (#db.scans > 3 or bytes > KEEP_BYTES) do
            bytes = bytes - (db.scans[1].estimatedBytes or KEEP_BYTES)
            table.remove(db.scans, 1)
        end
        local message = ("Saved %d of %d returned rows (%d unresolved). Coverage: partial.\nUse /reload, then run Auction Ledger Publisher."):format(#scan.rows, scan.received, scan.unresolved)
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
    finish("Stopped early by user", true)
end

local function readRow(index)
    local api = C_AuctionHouse
    local name, texture, count, quality, usable, level, levelType, minBid, increment,
        buyout, bid, highBidder, bidder, owner, ownerFullName, saleStatus, itemID = api.GetReplicateItemInfo(index)
    -- Names of sellers/bidders are never put in any table or SavedVariables.
    if type(itemID) ~= "number" or itemID < 1 or type(count) ~= "number" or count < 1
        or type(buyout) ~= "number" or buyout < 0 then return false end
    local key = variant(api.GetReplicateItemLink(index))
    if not key then
        if not job.requested[itemID] and C_Item and C_Item.RequestLoadItemDataByID then
            job.requested[itemID] = true
            C_Item.RequestLoadItemDataByID(itemID)
        end
        return false
    end
    if #key > 2048 then return false end
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
    if saveButton and #job.rows == 1 then saveButton:Enable() end
    job.bytes = job.bytes + #row + 64
    job.lastProgress = GetTime()
    return true
end

local function step()
    local now = GetTime()
    if not job.gotEvent then
        if now - job.began > WAIT then finish("No replicate response. The server may be on its full-scan cooldown.", false) end
        return
    end
    local total = C_AuctionHouse.GetNumReplicateItems() or 0
    if total < job.total then finish("The replicate list changed during capture; scan again later.", false); return end
    if total > MAX_ROWS then finish("The returned list exceeds the 250,000-row safety limit.", false); return end
    if total > job.total then
        -- Replicate indices are zero-based. Newly streamed rows join the current pass.
        for index = job.total, total - 1 do job.queue[#job.queue + 1] = index end
        job.total, job.lastGrowth = total, now
    end
    if total == 0 then
        if now - job.began > WAIT then finish("No auction rows returned.", false) end
        return
    end
    local began = debugprofilestop and debugprofilestop() or 0
    local processed = 0
    if now >= job.nextPass then
        while job.cursor <= #job.queue and processed < 400 do
            local index = job.queue[job.cursor]
            if not readRow(index) then job.retry[#job.retry + 1] = index end
            job.cursor, processed = job.cursor + 1, processed + 1
            if job.bytes > MAX_BYTES then finish("Capture exceeded the local file-size safety budget.", false); return end
            if debugprofilestop and debugprofilestop() - began > 3 then break end
        end
        if job.cursor > #job.queue then
            job.queue, job.retry, job.cursor, job.nextPass = job.retry, {}, 1, now + 0.5
        end
    end
    if #job.rows == total and now - math.max(job.lastEvent, job.lastGrowth) >= QUIET then
        -- No end-of-stream flag exists: a quiet list is still marked partial.
        finish("Replicate list settled", true); return
    end
    -- Cache notifications alone are not progress; unresolved rows must not extend this wait forever.
    if #job.rows < total and now - math.max(job.lastProgress, job.lastGrowth) >= RESOLVE then
        finish("Unresolved rows omitted after waiting for item data", #job.rows > 0); return
    end
    if now - job.began > WAIT + RESOLVE then finish("Capture timed out", false); return end
    status(("Captured %d / %d returned rows (%d remaining)\n%ds elapsed. Stop and Save keeps captured rows.\nKeep the AH open while scanning."):format(#job.rows, total, total - #job.rows, math.floor(now - job.began)))
end

local function start(faction)
    if job then say("A scan is already running."); return end
    if not auctionOpen then say("Open the Auction House first."); return end
    local api = C_AuctionHouse
    if not api or not api.ReplicateItems or not api.GetNumReplicateItems or not api.GetReplicateItemInfo or not api.GetReplicateItemLink then
        say("This client does not expose the required replicate API."); return
    end
    local db = database()
    if not db then return end
    local remaining = COOLDOWN - (time() - (db.lastResponseAt or 0))
    if remaining > 0 then say(("Full-scan cooldown: about %d more seconds."):format(remaining)); return end
    local now = GetTime()
    job = {startedAt = time(), began = now, faction = faction or UnitFactionGroup("player") or "Shared",
        gotEvent = false, lastEvent = now, lastGrowth = now, lastProgress = now,
        total = 0, cursor = 1, nextPass = 0, bytes = 1024,
        queue = {}, retry = {}, variants = {}, rows = {}, byVariant = {}, requested = {}}
    elapsedSincePoll = 0
    if scanButton then scanButton:Disable(); saveButton:Disable(); cancelButton:Enable() end
    status("Waiting for the server's auction list…\nThis can take several minutes. Keep the AH open.")
    say("Requested one full-list replication. Keep the AH open and leave other scan tools idle.")
    events:SetScript("OnUpdate", function(_, elapsed)
        elapsedSincePoll = elapsedSincePoll + elapsed
        if elapsedSincePoll < 0.05 then return end
        elapsedSincePoll = 0
        local ok, message = pcall(step)
        if not ok then finish("Capture error: " .. tostring(message), false) end
    end)
    local ok, message = pcall(api.ReplicateItems)
    if not ok then finish("Request failed: " .. tostring(message), false) end
end

local function showWindow()
    if not window then
        window = CreateFrame("Frame", "AuctionLedgerWindow", UIParent, "BasicFrameTemplateWithInset")
        window:SetSize(340, 190); window:SetPoint("CENTER"); window:SetClampedToScreen(true)
        window:SetMovable(true); window:EnableMouse(true); window:RegisterForDrag("LeftButton")
        window:SetScript("OnDragStart", window.StartMoving)
        window:SetScript("OnDragStop", window.StopMovingOrSizing)
        window.TitleText:SetText("Auction Ledger Scanner")
        label = window:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
        label:SetPoint("TOPLEFT", 16, -40); label:SetSize(308, 90); label:SetJustifyH("LEFT")
        label:SetText("Open the Auction House, then scan.\nAfter saving: /reload, then run the desktop publisher.")
        scanButton = CreateFrame("Button", nil, window, "UIPanelButtonTemplate")
        scanButton:SetSize(98, 26); scanButton:SetPoint("BOTTOMLEFT", 16, 16); scanButton:SetText("Scan auctions")
        scanButton:SetScript("OnClick", function() start() end)
        saveButton = CreateFrame("Button", "AuctionLedgerSaveButton", window, "UIPanelButtonTemplate")
        saveButton:SetSize(98, 26); saveButton:SetPoint("BOTTOM", 0, 16); saveButton:SetText("Stop and Save")
        saveButton:Disable(); saveButton:SetScript("OnClick", stopAndSave)
        cancelButton = CreateFrame("Button", nil, window, "UIPanelButtonTemplate")
        cancelButton:SetSize(98, 26); cancelButton:SetPoint("BOTTOMRIGHT", -16, 16); cancelButton:SetText("Cancel")
        cancelButton:Disable(); cancelButton:SetScript("OnClick", function() finish("Cancelled", false) end)
    end
    window:Show()
end

events:RegisterEvent("ADDON_LOADED")
events:RegisterEvent("AUCTION_HOUSE_SHOW")
events:RegisterEvent("AUCTION_HOUSE_CLOSED")
events:RegisterEvent("REPLICATE_ITEM_LIST_UPDATE")
events:SetScript("OnEvent", function(_, event, name)
    if event == "ADDON_LOADED" and name == "AuctionLedger" then database()
    elseif event == "AUCTION_HOUSE_SHOW" then auctionOpen = true
    elseif event == "AUCTION_HOUSE_CLOSED" then
        auctionOpen = false; finish("Auction House closed during capture", false)
    elseif event == "REPLICATE_ITEM_LIST_UPDATE" and job then
        if not job.gotEvent then
            local db = database()
            if db then db.lastResponseAt = time() end
        end
        job.gotEvent, job.lastEvent = true, GetTime()
    end
end)

SLASH_AUCTIONLEDGER1 = "/ald"
SlashCmdList.AUCTIONLEDGER = function(command)
    local action = (command or ""):lower():match("^%s*(.-)%s*$")
    if action == "scan" or action == "scan neutral" then
        showWindow(); start(action == "scan neutral" and "Neutral" or nil)
    elseif action == "save" then stopAndSave()
    elseif action == "cancel" then finish("Cancelled", false)
    elseif action == "status" then
        local db = database()
        if db then say(job and ("Capturing: %d / %d rows"):format(#job.rows, job.total) or ("%d saved scan(s). %s"):format(#db.scans, db.lastAttempt and db.lastAttempt.message or "No scan attempted.")) end
    else showWindow(); say("/ald scan · /ald scan neutral · /ald save · /ald cancel · /ald status") end
end
