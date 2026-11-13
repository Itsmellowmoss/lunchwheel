(() => {
    "use strict";

    const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const STORAGE_KEY = "lunch-wheel-custom-restaurants-v1";
    const HIDDEN_KEY = "lunch-wheel-hidden-restaurants-v1";
    const EDITED_KEY = "lunch-wheel-edited-restaurants-v1";
    const OSM_CACHE_KEY = "lunch-wheel-osm-cache-v3"; // v3: map-only bakeries are left out
    const OSM_CACHE_MAX_AGE = 2 * 60 * 60 * 1000;
    const OVERPASS_URL = "https://overpass.kumi.systems/api/interpreter";
    // Reviews are shared with lunchbot (the Slack bot): this is its reviews address on Vercel, e.g.
    // "https://your-lunchbot.vercel.app/api/reviews". Leave it empty to hide reviews.
    const REVIEWS_API = "https://lunchbot-rust.vercel.app/api/reviews";
    const REVIEWER_NAME_KEY = "lunch-wheel-reviewer-name-v1";
    const RATING_LABELS = { 5: "Loved it", 4: "Good", 3: "OK", 2: "Not great", 1: "Bad" };
    const SEARCH_RADIUS_METERS = 1400;
    const ORIGIN_COORDINATES = [59.3395657, 18.0592044];
    const CATEGORIES = ["Restaurant", "Cafe", "Fast food", "Bakery", "Sandwich shop", "Takeaway", "Brunch"];
    const NAME_COLLATOR = new Intl.Collator("sv", { sensitivity: "base", numeric: true });
    const WHEEL = document.querySelector("#wheel");
    const CONTEXT = WHEEL.getContext("2d");
    const WHEEL_TOOLTIP = document.querySelector("#wheel-tooltip");
    const WHEEL_TICKER = document.querySelector("#wheel-ticker");
    const SPIN_BUTTON = document.querySelector("#spin");
    const RESULT = document.querySelector("#result");
    const WINNER_DETAILS = document.querySelector("#winner-details");
    const WINNER_CARD = document.querySelector("#winner-card");
    const RESET_FILTERS = document.querySelector("#reset-filters");
    const FILTER_SETTINGS_KEY = "lunch-wheel-filters-v1";
    const WHEEL_EMPTY = document.querySelector("#wheel-empty");
    const WHEEL_EMPTY_TITLE = document.querySelector("#wheel-empty-title");
    const WHEEL_EMPTY_MESSAGE = document.querySelector("#wheel-empty-message");
    const CLEAR_WHEEL_FILTERS = document.querySelector("#clear-wheel-filters");
    const OPTION_LIST = document.querySelector("#option-list");
    const OPTION_COUNT = document.querySelector("#option-count");
    const TOAST = document.querySelector("#toast");
    const FORM = document.querySelector("#add-form");
    const FORM_MESSAGE = document.querySelector("#form-message");
    const FILTERS = {
        search: document.querySelector("#place-search"),
        showClosed: document.querySelector("#filter-closed"),
        showUnpriced: document.querySelector("#filter-unpriced"),
        showUnconfirmed: document.querySelector("#filter-unconfirmed"),
        vegetarian: document.querySelector("#filter-vegetarian"),
        walk: document.querySelector("#filter-walk"),
        price: document.querySelector("#filter-price")
    };
    const CATEGORY_FILTERS = [...document.querySelectorAll('input[name="filter-category"]')];
    const CATEGORY_FILTER_SUMMARY = document.querySelector("#category-filter-summary");

    let data;
    let restaurants = [];
    let customRestaurants = [];
    let editedRestaurants = [];
    let hiddenIds = [];
    let eligibleRestaurants = [];
    let rotation = 0;
    let hoveredRestaurantIndex = -1;
    let spinning = false;
    let lastIdleFrame = null;
    let osmRestaurants = [];
    let osmLookupRunning = false;
    let reviewSummaries = new Map();
    let reviewsState = REVIEWS_API ? "loading" : "off";
    let reviewableIds = new Set();
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    function showFormMessage(message, isError = false) {
        FORM_MESSAGE.textContent = message;
        FORM_MESSAGE.classList.toggle("error", isError);
    }

    function loadJsonFromStorage(key, fallback, validator) {
        let stored;
        try {
            stored = localStorage.getItem(key);
        } catch (error) {
            showFormMessage(`Could not access saved restaurant data: ${error.message}`, true);
            return fallback;
        }
        if (stored === null) return fallback;

        try {
            const value = JSON.parse(stored);
            if (!validator(value)) throw new Error("The saved data has an unexpected format.");
            return value;
        } catch (error) {
            showFormMessage(`Could not read saved restaurant data: ${error.message}`, true);
            return fallback;
        }
    }

    function saveUserData(messageTarget = FORM_MESSAGE) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(customRestaurants));
            localStorage.setItem(HIDDEN_KEY, JSON.stringify(hiddenIds));
            localStorage.setItem(EDITED_KEY, JSON.stringify(editedRestaurants));
            return true;
        } catch (error) {
            messageTarget.textContent = `Changes are active for this visit but could not be saved: ${error.message}`;
            messageTarget.classList.add("error");
            return false;
        }
    }

    function isStoredRestaurant(restaurant) {
        if (!restaurant || typeof restaurant !== "object" || Array.isArray(restaurant)
            || typeof restaurant.id !== "string" || typeof restaurant.name !== "string" || !restaurant.name.trim()) return false;

        const validOptionalNumber = (value, minimum) => value == null
            || (Number.isFinite(value) && value >= minimum);
        if (!validOptionalNumber(restaurant.walkMinutes, 1)
            || !validOptionalNumber(restaurant.priceMin, 0)
            || !validOptionalNumber(restaurant.priceMax, 0)) return false;
        if (restaurant.category != null && !CATEGORIES.includes(restaurant.category)) return false;

        if (restaurant.hours == null) return true;
        if (typeof restaurant.hours !== "object" || Array.isArray(restaurant.hours)) return false;
        return DAY_KEYS.every((day) => Array.isArray(restaurant.hours[day])
            && restaurant.hours[day].every((interval) => typeof interval === "string" && parseInterval(interval) !== null));
    }

    let stockholmTimeFormatter = null;

    // Edits are stored as only the fields the user changed, so updates to restaurants.js
    // (new prices, vegetarian research, hours) still show for places that were edited.
    const EDIT_FORMAT_VERSION = 2;
    const EDITABLE_FIELDS = [
        "name", "address", "category", "walkMinutes", "walkIsEstimate", "cuisine",
        "priceMin", "priceMax", "priceNote", "priceSource", "priceCheckedAt",
        "vegetarian", "vegetarianNote", "vegetarianSource",
        "hours", "hoursSource", "hoursCheckedAt"
    ];
    const EDITED_IN_APP = "Edited in Lunch Wheel";

    function sameValue(first, second) {
        return JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
    }

    function isStoredEdit(edit) {
        if (!edit || typeof edit !== "object" || Array.isArray(edit) || typeof edit.id !== "string") return false;
        if ("name" in edit && (typeof edit.name !== "string" || !edit.name.trim())) return false;
        const validOptionalNumber = (value, minimum) => value == null || (Number.isFinite(value) && value >= minimum);
        if (!validOptionalNumber(edit.walkMinutes, 1) || !validOptionalNumber(edit.priceMin, 0)
            || !validOptionalNumber(edit.priceMax, 0)) return false;
        if (edit.category != null && !CATEGORIES.includes(edit.category)) return false;
        if (edit.hours == null) return true;
        if (typeof edit.hours !== "object" || Array.isArray(edit.hours)) return false;
        return DAY_KEYS.every((day) => Array.isArray(edit.hours[day])
            && edit.hours[day].every((interval) => typeof interval === "string" && parseInterval(interval) !== null));
    }

    // Older versions saved a full copy of each edited place. Keep only what the user evidently changed.
    function migrateLegacyEdit(edit, base) {
        if (edit.editFormat === EDIT_FORMAT_VERSION) return edit;
        const migrated = { id: edit.id, editFormat: EDIT_FORMAT_VERSION };
        const copy = (fields) => fields.forEach((field) => {
            if (field in edit) migrated[field] = edit[field];
        });
        for (const field of ["name", "address", "category", "walkMinutes", "walkIsEstimate"]) {
            if (field in edit && (!base || !sameValue(edit[field], base[field]))) migrated[field] = edit[field];
        }
        if (edit.priceSource === EDITED_IN_APP) {
            copy(["priceMin", "priceMax", "priceSource", "priceCheckedAt"]);
            migrated.priceNote = "";
        }
        if (!base || (!edit.vegetarianSource && ["", "Updated in the app"].includes(edit.vegetarianNote || ""))) {
            copy(["vegetarian", "vegetarianNote", "vegetarianSource"]);
        }
        if (!base || edit.hoursSource === EDITED_IN_APP) {
            copy(["hours", "hoursSource", "hoursCheckedAt"]);
        }
        return migrated;
    }

    function getStockholmTime(date = new Date()) {
        stockholmTimeFormatter ||= new Intl.DateTimeFormat("en-GB", {
            timeZone: data.timezone,
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23"
        });
        const parts = stockholmTimeFormatter.formatToParts(date);
        const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        const weekday = values.weekday.toLowerCase().slice(0, 3);

        return {
            day: DAY_KEYS.findIndex((key) => key === weekday),
            minutes: Number(values.hour) * 60 + Number(values.minute),
            time: `${values.hour}:${values.minute}`
        };
    }

    function timeToMinutes(time) {
        const match = /^(\d{1,2}):(\d{2})$/.exec(time);
        if (!match) return null;
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        if (hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0)) return null;
        return hours * 60 + minutes;
    }

    function getIntervals(restaurant, day) {
        return restaurant.hours?.[DAY_KEYS[day]];
    }

    function parseInterval(interval) {
        const [startText, endText] = interval.split("-");
        const start = timeToMinutes(startText);
        let end = timeToMinutes(endText);
        if (start === null || end === null) return null;
        if (end <= start) end += 24 * 60;
        return { start, end };
    }

    function isOpenNow(restaurant, now) {
        const todaysIntervals = getIntervals(restaurant, now.day);
        if (!Array.isArray(todaysIntervals)) return null;

        for (const interval of todaysIntervals) {
            const parsed = parseInterval(interval);
            if (parsed && now.minutes >= parsed.start && now.minutes < parsed.end) return true;
        }

        const previousDay = (now.day + 6) % 7;
        const previousIntervals = getIntervals(restaurant, previousDay);
        if (Array.isArray(previousIntervals)) {
            for (const interval of previousIntervals) {
                const parsed = parseInterval(interval);
                if (parsed && parsed.end > 24 * 60 && now.minutes + 24 * 60 < parsed.end) return true;
            }
        }
        return false;
    }

    function servesLunch(restaurant) {
        const lunchStart = 11 * 60;
        const lunchEnd = 14 * 60;
        for (let day = 0; day < DAY_KEYS.length; day += 1) {
            const intervals = getIntervals(restaurant, day);
            if (!Array.isArray(intervals)) return true;
            if (intervals.some((interval) => {
                const parsed = parseInterval(interval);
                return parsed && parsed.start < lunchEnd && parsed.end > lunchStart;
            })) return true;
        }
        return false;
    }

    function nextOpening(restaurant, now) {
        for (let offset = 0; offset < 8; offset += 1) {
            const day = (now.day + offset) % 7;
            const intervals = getIntervals(restaurant, day);
            if (!Array.isArray(intervals)) continue;

            for (const interval of intervals) {
                const parsed = parseInterval(interval);
                if (!parsed) continue;
                const minuteOfDay = parsed.start % (24 * 60);
                if (offset > 0 || minuteOfDay > now.minutes) {
                    if (offset === 0) return `today at ${formatTime(minuteOfDay)}`;
                    if (offset === 1) return `tomorrow at ${formatTime(minuteOfDay)}`;
                    return `${DAY_NAMES[day]} at ${formatTime(minuteOfDay)}`;
                }
            }
        }
        return "no opening time listed";
    }

    function formatTime(minutes) {
        return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    }

    function getStatus(restaurant, now) {
        const open = isOpenNow(restaurant, now);
        if (open === null) return { state: "unknown", label: "Hours unconfirmed · may be closed" };
        if (open) return { state: "open", label: "Open now" };
        return { state: "closed", label: `Closed now · opens ${nextOpening(restaurant, now)}` };
    }

    function matchesOtherFilters(restaurant, now) {
        const isExplicitlyExcludedForLunch = (data.lunchExcludedNames || [])
            .some((name) => normalizeName(name) === normalizeName(restaurant.name));
        if (isExplicitlyExcludedForLunch) return false;
        // Single branches left out on purpose (other branches of the same name stay), matched by name and location
        const isExcludedBranch = (data.lunchExcludedPlaces || []).some((place) => namesMatch(place.name, restaurant.name)
            && Number.isFinite(restaurant.latitude) && Number.isFinite(restaurant.longitude)
            && distanceInMeters(restaurant.latitude, restaurant.longitude, place.latitude, place.longitude) <= 100);
        if (isExcludedBranch) return false;

        const searchTerm = normalizeName(FILTERS.search.value.trim());
        if (searchTerm) {
            const searchableText = normalizeName([
                restaurant.name,
                restaurant.address,
                restaurant.cuisine,
                getCategory(restaurant)
            ].filter(Boolean).join(" "));
            if (!searchableText.includes(searchTerm)) return false;
        }
        if (!servesLunch(restaurant)) return false;
        if (FILTERS.vegetarian.checked && restaurant.vegetarian !== "yes") return false;
        const selectedCategories = CATEGORY_FILTERS.filter((input) => input.checked).map((input) => input.value);
        if (selectedCategories.length && !selectedCategories.includes(getCategory(restaurant))) return false;
        if (!FILTERS.showUnpriced.checked && restaurant.priceMin == null && restaurant.priceMax == null) return false;
        // Hours unconfirmed = no known opening hours for today
        if (!FILTERS.showUnconfirmed.checked && getStatus(restaurant, now).state === "unknown") return false;

        const maxWalk = Number(FILTERS.walk.value);
        if (maxWalk && (!restaurant.walkMinutes || restaurant.walkMinutes > maxWalk)) return false;

        const maxPrice = Number(FILTERS.price.value);
        // A place fits if its cheapest lunch does (Mister York's 59 kr meal fits "120 kr" even though others cost 139)
        const cheapest = restaurant.priceMin ?? restaurant.priceMax;
        if (maxPrice && (cheapest == null || cheapest > maxPrice)) return false;
        return true;
    }

    function getFilteredRestaurants(now) {
        return restaurants.filter((restaurant) => !hiddenIds.includes(restaurant.id)
            && matchesOtherFilters(restaurant, now));
    }

    // How much we know about a place: known hours, prices, a menu, vegetarian info and reviews all count
    function informationScore(restaurant) {
        let score = 0;
        if (restaurant.hours) score += 2;
        if (restaurant.priceMin != null || restaurant.priceMax != null) score += 2;
        if (restaurant.priceNote) score += 1;
        if (restaurant.vegetarian === "yes" || restaurant.vegetarian === "no") score += 1;
        if (reviewSummaries.has(restaurant.id)) score += 1;
        if (restaurant.unverified) score -= 1;
        return score;
    }

    // Places with the most information first; closed places stay at the bottom
    function compareByRelevance(first, second, now) {
        const statusOrder = { open: 0, unknown: 1, closed: 2 };
        const firstState = getStatus(first, now).state;
        const secondState = getStatus(second, now).state;
        return (firstState === "closed") - (secondState === "closed")
            || informationScore(second) - informationScore(first)
            || statusOrder[firstState] - statusOrder[secondState]
            || compareRestaurants(first, second);
    }

    function directionsUrl(restaurant) {
        const destination = Number.isFinite(restaurant.latitude) && Number.isFinite(restaurant.longitude)
            ? `${restaurant.latitude},${restaurant.longitude}`
            : restaurant.address || `${restaurant.name}, Stockholm`;
        return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(data.origin)}&destination=${encodeURIComponent(destination)}&travelmode=walking`;
    }

    function googleMapsUrl(restaurant) {
        return restaurant.mapUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${restaurant.name} ${restaurant.address || "Stockholm"}`)}`;
    }

    function compareRestaurants(first, second) {
        return NAME_COLLATOR.compare(first.name, second.name) || first.id.localeCompare(second.id);
    }

    // Chains: "Espresso House Odenplan", "Espresso House" and "Bröd & Salt - Sveavägen" are branches of one brand.
    // Branches of a brand share one card in the list and one slice on the wheel.
    const AREA_WORDS = new Set(["odenplan", "vasastan", "vasastaden", "city", "stureplan", "hotorget", "konserthuset",
        "plattan", "norrmalm", "centralen", "sergels", "torg", "centrum"]);
    let streetWords = null;
    let brands = new Map(); // brand key -> { name, count }
    const selectedBranches = new Map(); // brand key -> id of the branch picked in the list
    const openCards = new Set(); // brand keys of the lunch spots opened in the list (they stay open when it re-renders)

    function brandKey(restaurant) {
        streetWords ||= new Set(data.restaurants
            .map((place) => normalizeName((place.address || "").split(/\d/)[0]).split(" ")[0])
            .filter((word) => word.length > 3));
        const words = normalizeName(restaurant.name.split(/\s+[-–—|]\s+/)[0]).split(" ");
        while (words.length > 1 && (AREA_WORDS.has(words.at(-1)) || streetWords.has(words.at(-1)) || /^\d+[a-z]?$/.test(words.at(-1)))) {
            words.pop();
        }
        return words.join(" ");
    }

    function buildBrands() {
        brands = new Map();
        for (const restaurant of restaurants) {
            if (hiddenIds.includes(restaurant.id)) continue;
            const key = brandKey(restaurant);
            const name = restaurant.name.split(/\s+[-–—|]\s+/)[0].trim();
            const brand = brands.get(key);
            if (!brand) brands.set(key, { name, count: 1 });
            else {
                brand.count += 1;
                if (name.length < brand.name.length) brand.name = name;
            }
        }
    }

    const isChain = (restaurant) => (brands.get(brandKey(restaurant))?.count || 0) > 1;
    const shortAddress = (restaurant) => (restaurant.address || "").split(",")[0].trim();

    // The filtered places as brands: [[branch, branch…], …] in list order, one branch per address
    function groupBranches(places) {
        const groups = new Map();
        for (const place of places) {
            const key = brandKey(place);
            const group = groups.get(key) || groups.set(key, []).get(key);
            const address = normalizeName(place.address || place.id);
            if (!group.some((other) => normalizeName(other.address || other.id) === address)) group.push(place);
        }
        return [...groups.values()];
    }

    // The branch a brand shows: the one picked in the list, otherwise the nearest
    function pickBranch(branches) {
        const selected = branches.find((branch) => branch.id === selectedBranches.get(brandKey(branch)));
        if (selected) return selected;
        return [...branches].sort((a, b) => (a.walkMinutes ?? 999) - (b.walkMinutes ?? 999))[0];
    }

    function displayRestaurantName(restaurant) {
        if (isChain(restaurant)) return brands.get(brandKey(restaurant)).name;
        return restaurant.name.replace(/\s*(?:[-–—,]\s*|\s+)(?:Odenplan|Vasastaden|Vasastan)$/i, "").trim();
    }

    function wrapWheelLabel(value, maxWidth) {
        const words = value.trim().split(/\s+/).filter(Boolean);
        const lines = [];
        let line = "";

        for (const word of words) {
            const candidate = line ? `${line} ${word}` : word;
            if (CONTEXT.measureText(candidate).width <= maxWidth) {
                line = candidate;
                continue;
            }

            if (line) lines.push(line);
            line = "";
            for (const character of word) {
                const next = line + character;
                if (line && CONTEXT.measureText(next).width > maxWidth) {
                    lines.push(line);
                    line = character;
                } else {
                    line = next;
                }
            }
        }

        if (line) lines.push(line);
        return lines.length ? lines : [value];
    }

    function priceText(restaurant) {
        if (restaurant.priceMin == null && restaurant.priceMax == null) {
            return restaurant.dataSource === "OpenStreetMap" ? "Price not listed" : "Price not added";
        }
        if (restaurant.priceMin == null) return `Up to ${restaurant.priceMax} kr`;
        if (restaurant.priceMax == null) return `From ${restaurant.priceMin} kr`;
        if (restaurant.priceMin === restaurant.priceMax) return `About ${restaurant.priceMin} kr`;
        return `About ${restaurant.priceMin}–${restaurant.priceMax} kr`;
    }

    function normalizeName(value) {
        return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
            .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }

    function namesMatch(first, second) {
        const a = normalizeName(first);
        const b = normalizeName(second);
        if (!a || !b) return false;
        if (a === b || a.includes(b) || b.includes(a)) return true;
        const firstWords = new Set(a.split(/\s+/).filter((word) => word.length > 2));
        const secondWords = new Set(b.split(/\s+/).filter((word) => word.length > 2));
        const common = [...firstWords].filter((word) => secondWords.has(word)).length;
        return common >= 2 && common / Math.max(firstWords.size, secondWords.size) >= 0.7;
    }

    function getCategory(restaurant) {
        if (CATEGORIES.includes(restaurant.category)) return restaurant.category;
        const searchable = normalizeName(`${restaurant.name} ${restaurant.cuisine || ""}`);
        if (/\b(bakery|bakeries|konditori|pastry)\b/.test(searchable)) return "Bakery";
        if (/\b(sandwich|smorgas|deli)\b/.test(searchable)) return "Sandwich shop";
        if (/\b(cafe|coffee|kaffebar)\b/.test(searchable)) return "Cafe";
        if (/\b(brunch)\b/.test(searchable)) return "Brunch";
        if (/\b(takeaway|take away)\b/.test(searchable)) return "Takeaway";
        if (/\b(fast food|kebab|burger|hamburger|grill)\b/.test(searchable)) return "Fast food";
        return "Restaurant";
    }

    function parseOsmOpeningHours(value) {
        if (!value) return null;
        const dayAbbreviations = { Mo: "Mon", Tu: "Tue", We: "Wed", Th: "Thu", Fr: "Fri", Sa: "Sat", Su: "Sun" };
        let normalized = value.trim();
        if (normalized === "24/7") normalized = "Daily 00:00-24:00";
        else {
            normalized = normalized.replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su)\b/g, (day) => dayAbbreviations[day]);
            normalized = normalized.replace(/\boff\b/gi, "closed");
        }
        try {
            return parseWeeklyHours(normalized);
        } catch {
            return null;
        }
    }

    function formatWeeklyHours(hours) {
        return DAY_NAMES.map((dayName, index) => {
            const intervals = hours[DAY_KEYS[index]];
            return `${dayName.slice(0, 3)} ${intervals.length ? intervals.join(", ") : "closed"}`;
        }).join("; ");
    }

    function distanceInMeters(latitude, longitude, referenceLatitude = ORIGIN_COORDINATES[0], referenceLongitude = ORIGIN_COORDINATES[1]) {
        const radians = (degrees) => degrees * Math.PI / 180;
        const latitudeDelta = radians(latitude - referenceLatitude);
        const longitudeDelta = radians(longitude - referenceLongitude);
        const haversine = Math.sin(latitudeDelta / 2) ** 2
            + Math.cos(radians(referenceLatitude)) * Math.cos(radians(latitude))
            * Math.sin(longitudeDelta / 2) ** 2;
        return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
    }

    function getSearchQuadrants() {
        const [latitude, longitude] = ORIGIN_COORDINATES;
        const latitudeDelta = SEARCH_RADIUS_METERS / 111_320;
        const longitudeDelta = SEARCH_RADIUS_METERS / (111_320 * Math.cos(latitude * Math.PI / 180));
        const south = latitude - latitudeDelta;
        const north = latitude + latitudeDelta;
        const west = longitude - longitudeDelta;
        const east = longitude + longitudeDelta;
        return [
            [south, west, latitude, longitude],
            [south, longitude, latitude, east],
            [latitude, west, north, longitude],
            [latitude, longitude, north, east]
        ];
    }

    function buildOverpassQuery(bounds) {
        const [south, west, north, east] = bounds.map((value) => value.toFixed(6));
        const box = `(${south},${west},${north},${east})`;
        return `[out:json][timeout:15];nwr["amenity"~"^(restaurant|fast_food|cafe|food_court|takeaway)$"]${box};nwr["shop"~"^(bakery|sandwich|deli|pastry)$"]${box};out center tags;`;
    }

    async function fetchSearchQuadrant(bounds, signal) {
        const response = await fetch(OVERPASS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
            body: new URLSearchParams({ data: buildOverpassQuery(bounds) }),
            signal
        });
        if (!response.ok) throw new Error(`OpenStreetMap returned HTTP ${response.status}.`);
        const result = await response.json();
        if (!Array.isArray(result.elements)) {
            throw new Error(result.remark || "OpenStreetMap returned an unexpected response.");
        }
        return result.elements;
    }

    function uniqueNearbyPlaces(places) {
        const unique = [];
        for (const place of places) {
            const distance = Number.isFinite(place.latitude) && Number.isFinite(place.longitude)
                ? distanceInMeters(place.latitude, place.longitude)
                : Infinity;
            if (distance > SEARCH_RADIUS_METERS) continue;
            const duplicateIndex = unique.findIndex((existing) => {
                if (existing.id === place.id) return true;
                if (normalizeName(existing.name) !== normalizeName(place.name)) return false;
                if (![existing.latitude, existing.longitude, place.latitude, place.longitude].every(Number.isFinite)) {
                    return true;
                }
                return distanceInMeters(existing.latitude, existing.longitude, place.latitude, place.longitude) <= 60;
            });
            if (duplicateIndex === -1) {
                unique.push(place);
                continue;
            }

            const existing = unique[duplicateIndex];
            unique[duplicateIndex] = {
                ...existing,
                ...place,
                address: place.address || existing.address,
                hours: place.hours || existing.hours,
                openingHoursText: place.openingHoursText || existing.openingHoursText,
                cuisine: place.cuisine || existing.cuisine,
                vegetarian: place.vegetarian === "unknown" ? existing.vegetarian : place.vegetarian,
                vegetarianNote: place.vegetarian === "unknown" ? existing.vegetarianNote : place.vegetarianNote,
                vegetarianSource: place.vegetarian === "unknown" ? existing.vegetarianSource : place.vegetarianSource
            };
        }
        return unique.sort(compareRestaurants);
    }

    function restaurantFromOsm(element) {
        const tags = element.tags || {};
        const name = tags.name || tags["name:en"];
        if (!name) return null;
        // Bakeries and pastry shops found only on the map are mostly buns and cakes, not lunch
        if (["bakery", "pastry", "confectionery"].includes(tags.shop)) return null;
        const latitude = element.lat ?? element.center?.lat;
        const longitude = element.lon ?? element.center?.lon;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

        const distance = distanceInMeters(latitude, longitude);
        const walkMinutes = Math.max(1, Math.ceil(distance * 1.3 / 83.33));
        const street = tags["addr:street"];
        const houseNumber = tags["addr:housenumber"];
        const address = [street && [street, houseNumber].filter(Boolean).join(" "), tags["addr:postcode"], tags["addr:city"]]
            .filter(Boolean).join(", ");
        const vegetarian = ["yes", "only"].includes((tags["diet:vegetarian"] || "").toLowerCase())
            ? "yes"
            : (tags["diet:vegetarian"] || "").toLowerCase() === "no" ? "no" : "unknown";

        return {
            id: `osm-${element.type}-${element.id}`,
            name,
            address,
            mapUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${address || `${latitude},${longitude}`}`)}`,
            walkMinutes,
            walkIsEstimate: true,
            priceMin: null,
            priceMax: null,
            vegetarian,
            vegetarianNote: vegetarian === "yes" ? "Listed in OpenStreetMap" : "",
            hours: parseOsmOpeningHours(tags.opening_hours),
            openingHoursText: tags.opening_hours || "",
            openingHoursSource: tags.opening_hours ? "OpenStreetMap" : "",
            cuisine: tags.cuisine || "",
            category: getCategory({ name, cuisine: [tags.cuisine, tags.amenity, tags.shop].filter(Boolean).join(" ") }),
            latitude,
            longitude,
            dataSource: "OpenStreetMap"
        };
    }

    function findNearbyMatchIndex(restaurant, nearby) {
        const matchingIndexes = nearby
            .map((place, index) => namesMatch(restaurant.name, place.name) ? index : -1)
            .filter((index) => index !== -1);
        if (matchingIndexes.length === 0) return -1;

        const hasCoordinates = Number.isFinite(restaurant.latitude) && Number.isFinite(restaurant.longitude);
        if (!hasCoordinates) return matchingIndexes.length === 1 ? matchingIndexes[0] : -1;

        let closestIndex = -1;
        let closestDistance = Infinity;
        for (const index of matchingIndexes) {
            const place = nearby[index];
            if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
            const distance = distanceInMeters(restaurant.latitude, restaurant.longitude, place.latitude, place.longitude);
            if (distance < closestDistance) {
                closestIndex = index;
                closestDistance = distance;
            }
        }
        return closestDistance <= 150 ? closestIndex : -1;
    }

    function applySavedRestaurantEdits(places) {
        const editsById = new Map(editedRestaurants.map((edit) => [edit.id, edit]));
        return places.map((restaurant) => {
            const edit = editsById.get(restaurant.id);
            if (!edit) return restaurant;
            const { editFormat, ...changes } = edit;
            return { ...restaurant, ...changes };
        });
    }

    function mergeNearbyRestaurants(nearby) {
        const unmatched = [...nearby];
        const seededRestaurants = data.restaurants.map((seed) => {
            const matchIndex = findNearbyMatchIndex(seed, unmatched);
            if (matchIndex === -1) return seed;
            const [place] = unmatched.splice(matchIndex, 1);
            // The researched seed data wins; OpenStreetMap only fills gaps the seed leaves open.
            const useOsmVegetarian = (seed.vegetarian || "unknown") === "unknown" && place.vegetarian !== "unknown";
            const useOsmHours = !seed.hours && Boolean(place.hours);
            return {
                ...place,
                ...seed,
                address: seed.address || place.address,
                walkMinutes: seed.walkMinutes ?? place.walkMinutes,
                walkIsEstimate: seed.walkMinutes != null ? Boolean(seed.walkIsEstimate) : Boolean(place.walkIsEstimate),
                cuisine: seed.cuisine || place.cuisine,
                category: seed.category || place.category,
                vegetarian: useOsmVegetarian ? place.vegetarian : seed.vegetarian,
                vegetarianNote: useOsmVegetarian ? place.vegetarianNote : seed.vegetarianNote,
                vegetarianSource: useOsmVegetarian ? place.vegetarianSource : seed.vegetarianSource,
                hours: seed.hours || place.hours,
                openingHoursText: useOsmHours ? place.openingHoursText : "",
                openingHoursSource: useOsmHours ? place.openingHoursSource : "",
                dataSource: "Saved list"
            };
        });
        const savedRestaurants = customRestaurants.map((custom) => {
            const matchIndex = findNearbyMatchIndex(custom, unmatched);
            if (matchIndex === -1) return custom;
            const [place] = unmatched.splice(matchIndex, 1);
            return {
                ...place,
                ...custom,
                address: custom.address || place.address,
                walkMinutes: custom.walkMinutes ?? place.walkMinutes,
                walkIsEstimate: custom.walkMinutes != null ? Boolean(custom.walkIsEstimate) : Boolean(place.walkIsEstimate),
                vegetarian: custom.vegetarian === "unknown" ? place.vegetarian : custom.vegetarian,
                vegetarianNote: custom.vegetarianNote || place.vegetarianNote,
                vegetarianSource: custom.vegetarian === "unknown" ? place.vegetarianSource : custom.vegetarianSource,
                hours: custom.hours || place.hours,
                dataSource: place.dataSource
            };
        });
        restaurants = applySavedRestaurantEdits([...seededRestaurants, ...unmatched, ...savedRestaurants]);
        osmRestaurants = nearby;
        renderRestaurants();
    }

    function readOsmCache() {
        try {
            const cache = JSON.parse(localStorage.getItem(OSM_CACHE_KEY) || "null");
            if (!cache || !Number.isFinite(cache.fetchedAt) || !Array.isArray(cache.restaurants)
                || !cache.restaurants.every(isStoredRestaurant)) return null;
            return cache;
        } catch (error) {
            console.warn("Could not read the saved map data:", error);
            return null;
        }
    }

    function saveOsmCache(cache) {
        try {
            localStorage.setItem(OSM_CACHE_KEY, JSON.stringify(cache));
        } catch (error) {
            console.warn("Could not save the map data:", error);
        }
    }

    // Adds nearby places from OpenStreetMap in the background when the page opens (reusing the last copy for up to
    // two hours). The saved list works on its own, so a failed lookup just leaves it as it is.
    async function refreshNearbyData() {
        if (osmLookupRunning) return;
        const cached = readOsmCache();
        if (cached?.restaurants.length) {
            mergeNearbyRestaurants(cached.restaurants);
            if (Date.now() - cached.fetchedAt < OSM_CACHE_MAX_AGE) return;
        }

        osmLookupRunning = true;
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 20_000);
        try {
            const quadrantResults = await Promise.allSettled(
                getSearchQuadrants().map((bounds) => fetchSearchQuadrant(bounds, controller.signal))
            );
            const failures = quadrantResults.filter((result) => result.status === "rejected");
            if (failures.length === quadrantResults.length) {
                throw new Error(failures.map((result) => result.reason.message).join(" "));
            }
            const livePlaces = uniqueNearbyPlaces(quadrantResults
                .filter((result) => result.status === "fulfilled")
                .flatMap((result) => result.value)
                .map(restaurantFromOsm)
                .filter(Boolean));
            const nearby = uniqueNearbyPlaces([
                ...livePlaces,
                ...(failures.length ? cached?.restaurants || [] : [])
            ]);
            mergeNearbyRestaurants(nearby);
            saveOsmCache({ fetchedAt: Date.now(), restaurants: nearby });
        } catch (error) {
            console.warn("Nearby map lookup failed:", controller.signal.aborted ? "timed out" : error);
        } finally {
            window.clearTimeout(timeout);
            osmLookupRunning = false;
        }
    }

    // A short message at the bottom of the screen, e.g. after saving a review
    let toastTimer = null;
    function showToast(message) {
        TOAST.textContent = message;
        TOAST.hidden = false;
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => {
            TOAST.hidden = true;
        }, 4000);
    }

    function drawWheel() {
        const bounds = WHEEL.getBoundingClientRect();
        if (!bounds.width) return;

        const pixelRatio = window.devicePixelRatio || 1;
        const canvasWidth = Math.round(bounds.width * pixelRatio);
        const canvasHeight = Math.round(bounds.height * pixelRatio);
        // Resizing a canvas reallocates it, so only do so when the size really changed.
        if (WHEEL.width !== canvasWidth || WHEEL.height !== canvasHeight) {
            WHEEL.width = canvasWidth;
            WHEEL.height = canvasHeight;
        }
        CONTEXT.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

        const size = bounds.width;
        const center = size / 2;
        const radius = center - 17;
        const count = eligibleRestaurants.length;
        const slice = (Math.PI * 2) / Math.max(count, 1);
        const showSliceDetails = size >= 390 && count <= 9;
        const now = showSliceDetails ? getStockholmTime() : null;
        const fontSize = Math.max(10, Math.min(18, size / 24, 27 / Math.sqrt(Math.max(1, count / 7))));
        // Names only show while there's room for them: at most 36 slices, and tall enough near the middle of the wheel
        // where a name starts (smaller wheels, like on phones, switch to the pointer label sooner)
        const showLabels = count <= 36 && radius * 0.4 * slice >= fontSize * 1.05;
        // Borders only while slices are wide enough to see between them
        const sliceWidthAtRim = radius * slice;
        const borderWidth = sliceWidthAtRim >= 14 ? 3 : sliceWidthAtRim >= 6 ? 1 : 0;
        CONTEXT.clearRect(0, 0, size, size);

        eligibleRestaurants.forEach((restaurant, index) => {
            const start = -Math.PI / 2 + rotation + index * slice;
            const end = start + slice;
            const isHovered = !spinning && index === hoveredRestaurantIndex;
            const sliceRadius = radius + (isHovered ? 13 : 0);
            CONTEXT.beginPath();
            CONTEXT.moveTo(center, center);
            // Thin slices get a hair of overlap so no gaps show between them
            CONTEXT.arc(center, center, sliceRadius, start, end + (borderWidth ? 0 : 0.004));
            CONTEXT.closePath();
            // Rainbow: the colour follows the slice's place around the wheel. Labelled slices are a bit darker so
            // the white names stay readable; thin ones alternate shades so neighbours can be told apart.
            const hue = Math.round(index / count * 360);
            const brightHue = hue >= 45 && hue <= 200; // yellows, greens and cyans need to be darker behind white text
            const lightness = isHovered ? 46 : showLabels ? (brightHue ? 45 : 54) : index % 2 ? 60 : 66;
            CONTEXT.fillStyle = `hsl(${hue} ${isHovered ? 70 : 60}% ${lightness}%)`;
            CONTEXT.fill();
            if (borderWidth) {
                CONTEXT.strokeStyle = "#fffaf2";
                CONTEXT.lineWidth = isHovered ? borderWidth + 1 : borderWidth;
                CONTEXT.stroke();
            }
            if (!showLabels) return;

            CONTEXT.save();
            CONTEXT.translate(center, center);
            const labelAngle = start + slice / 2;
            const normalizedAngle = ((labelAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
            const flipLabel = normalizedAngle > Math.PI / 2 && normalizedAngle < Math.PI * 3 / 2;
            CONTEXT.rotate(labelAngle + (flipLabel ? Math.PI : 0));
            CONTEXT.textAlign = "center";
            CONTEXT.textBaseline = "middle";
            CONTEXT.fillStyle = "#fff";
            CONTEXT.shadowColor = "#30251d66";
            CONTEXT.shadowBlur = 2;
            CONTEXT.font = `700 ${fontSize}px "Trebuchet MS", sans-serif`;
            const maxWidth = radius * 0.7;
            const name = displayRestaurantName(restaurant);
            const nameWidth = CONTEXT.measureText(name).width;
            const labelScale = Math.min(1.45, Math.max(1, maxWidth * 0.9 / nameWidth));
            // Never taller than the slice where the name sits, and only wrap onto lines that fit;
            // otherwise keep the name on one line (fillText squeezes it to fit the width)
            const roomAtLabel = radius * 0.63 * slice;
            // Long names reach in towards the middle, where the slice is narrowest, so size them for that too
            const labelFontSize = Math.min(fontSize * labelScale, roomAtLabel * 0.72, radius * 0.32 * slice * 1.1);
            CONTEXT.font = `700 ${labelFontSize}px "Trebuchet MS", sans-serif`;
            const maxLines = Math.max(1, Math.floor(roomAtLabel / (labelFontSize * 1.25)));
            const wrapped = wrapWheelLabel(name, maxWidth);
            const scaledNameLines = wrapped.length <= maxLines ? wrapped : [name];
            const textX = (flipLabel ? -1 : 1) * (radius + (isHovered ? 7 : 0)) * 0.63;
            const verticalDirection = flipLabel ? -1 : 1;
            const lineHeight = labelFontSize * 1.08;
            const nameStart = -((scaledNameLines.length - 1) * lineHeight) / 2;
            scaledNameLines.forEach((line, lineIndex) => {
                CONTEXT.fillText(line, textX, verticalDirection * (nameStart + lineIndex * lineHeight), maxWidth);
            });
            if (showSliceDetails) {
                const status = getStatus(restaurant, now).state;
                const price = restaurant.priceMin != null && restaurant.priceMax != null
                    ? (restaurant.priceMin === restaurant.priceMax
                        ? `${restaurant.priceMin} kr`
                        : `${restaurant.priceMin}–${restaurant.priceMax} kr`)
                    : "";
                const extraDetails = [
                    status === "closed" ? "Closed" : status === "unknown" ? "Hours unconfirmed" : "Open",
                    restaurant.walkMinutes ? `${restaurant.walkIsEstimate ? "~" : ""}${restaurant.walkMinutes} min` : "",
                    price
                ].filter(Boolean).join(" · ");

                const detailFontSize = Math.max(7, fontSize * 0.54);
                CONTEXT.font = `600 ${detailFontSize}px "Trebuchet MS", sans-serif`;
                const detailY = ((scaledNameLines.length - 1) * lineHeight) / 2
                    + labelFontSize / 2
                    + detailFontSize * 0.7;
                CONTEXT.fillText(
                    extraDetails,
                    textX,
                    verticalDirection * detailY,
                    maxWidth
                );
            }
            CONTEXT.restore();
        });

        updateWheelTicker(showLabels, slice);


    }

    // Which slice the pointer is over (an index into eligibleRestaurants), or -1 for none
    function wheelIndexAt(event) {
        const bounds = WHEEL.getBoundingClientRect();
        const x = event.clientX - bounds.left - bounds.width / 2;
        const y = event.clientY - bounds.top - bounds.height / 2;
        const distance = Math.hypot(x, y);
        const radius = bounds.width / 2 - 17;
        if (distance < SPIN_BUTTON.offsetWidth / 2 + 4 || distance > radius + 13) return -1; // the middle is the spin button
        const angle = Math.atan2(y, x);
        const relativeAngle = ((angle + Math.PI / 2 - rotation) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        return Math.floor(relativeAngle / (Math.PI * 2) * eligibleRestaurants.length);
    }

    // Clicking a slice searches for that place and opens it in the list
    function searchForWheelSlice(event) {
        if (spinning || eligibleRestaurants.length === 0) return;
        const index = wheelIndexAt(event);
        if (index < 0) return;
        const restaurant = eligibleRestaurants[index];
        FILTERS.search.value = displayRestaurantName(restaurant);
        selectedBranches.set(brandKey(restaurant), restaurant.id);
        openCards.add(brandKey(restaurant));
        WINNER_DETAILS.replaceChildren();
        renderRestaurants();
        const item = [...OPTION_LIST.children].find((li) => li.dataset.brand === brandKey(restaurant));
        if (!item) return;
        item.focus({ preventScroll: true });
        item.scrollIntoView({ behavior: prefersReducedMotion.matches ? "auto" : "smooth", block: "center" });
    }

    // With too many slices for names, a label under the pointer shows which place it's on (it flickers while spinning)
    function updateWheelTicker(showLabels, slice) {
        const restaurant = !showLabels && eligibleRestaurants.length
            ? eligibleRestaurants[Math.floor((((-rotation) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / slice) % eligibleRestaurants.length]
            : null;
        WHEEL_TICKER.hidden = !restaurant;
        const text = restaurant ? displayRestaurantName(restaurant) : "";
        if (WHEEL_TICKER.textContent !== text) WHEEL_TICKER.textContent = text;
    }

    function updateWheelHover(event) {
        if (spinning || eligibleRestaurants.length === 0) return;
        const nextIndex = wheelIndexAt(event);
        WHEEL.style.cursor = nextIndex >= 0 ? "pointer" : "";
        if (nextIndex === hoveredRestaurantIndex) {
            if (nextIndex >= 0) positionWheelTooltip(event.clientX, event.clientY);
            return;
        }

        hoveredRestaurantIndex = nextIndex;
        if (nextIndex < 0) {
            WHEEL_TOOLTIP.hidden = true;
        } else {
            showWheelTooltip(eligibleRestaurants[nextIndex], event.clientX, event.clientY);
        }
        drawWheel();
    }

    function positionWheelTooltip(clientX, clientY) {
        const frame = WHEEL.closest(".wheel-frame");
        const bounds = frame.getBoundingClientRect();
        const tooltipWidth = WHEEL_TOOLTIP.offsetWidth;
        const tooltipHeight = WHEEL_TOOLTIP.offsetHeight;
        const left = Math.max(8, Math.min(clientX - bounds.left + 12, bounds.width - tooltipWidth - 8));
        const top = Math.max(8, Math.min(clientY - bounds.top + 12, bounds.height - tooltipHeight - 8));
        WHEEL_TOOLTIP.style.left = `${left}px`;
        WHEEL_TOOLTIP.style.top = `${top}px`;
    }

    function showWheelTooltip(restaurant, clientX, clientY) {
        const status = getStatus(restaurant, getStockholmTime());
        const name = document.createElement("strong");
        name.textContent = displayRestaurantName(restaurant);
        const category = document.createElement("span");
        category.className = "tooltip-category";
        category.textContent = getCategory(restaurant);
        const details = document.createElement("span");
        details.textContent = [
            status.state === "unknown" ? "Hours not confirmed" : status.label,
            restaurant.address || "",
            restaurant.walkMinutes ? `${restaurant.walkIsEstimate ? "~" : ""}${restaurant.walkMinutes} min walk` : "",
            priceText(restaurant),
            ratingSummaryText(restaurant)
        ].filter(Boolean).join(" · ");
        WHEEL_TOOLTIP.replaceChildren(name, category, details);
        WHEEL_TOOLTIP.hidden = false;
        positionWheelTooltip(clientX, clientY);
    }

    function isWebLink(value) {
        return typeof value === "string" && /^https?:\/\//i.test(value);
    }

    function createLink(href, label, className = "") {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = label;
        if (className) link.className = className;
        return link;
    }

    function createEditorField(labelText, control) {
        const label = document.createElement("label");
        label.append(labelText, control);
        return label;
    }

    function createEditForm(restaurant) {
        const form = document.createElement("form");
        form.className = "edit-form";
        const fields = document.createElement("div");
        fields.className = "edit-fields";
        const makeInput = (type, value, options = {}) => {
            const input = document.createElement(type === "textarea" ? "textarea" : "input");
            if (type !== "textarea") input.type = type;
            input.value = value ?? "";
            if (options.min != null) input.min = String(options.min);
            if (options.max != null) input.max = String(options.max);
            if (options.maxLength != null) input.maxLength = options.maxLength;
            if (options.placeholder) input.placeholder = options.placeholder;
            if (type === "textarea") {
                input.rows = 4;
                input.placeholder = options.placeholder || "";
            }
            return input;
        };
        const name = makeInput("text", restaurant.name, { maxLength: 80 });
        const address = makeInput("text", restaurant.address, { maxLength: 120 });
        const category = document.createElement("select");
        for (const value of CATEGORIES) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            category.append(option);
        }
        category.value = getCategory(restaurant);
        const walking = makeInput("number", restaurant.walkMinutes, { min: 1, max: 120, placeholder: "Not set" });
        const estimated = document.createElement("input");
        estimated.type = "checkbox";
        estimated.checked = Boolean(restaurant.walkIsEstimate);
        const walkingField = document.createElement("label");
        walkingField.className = "edit-walking-field";
        const walkingLabel = document.createElement("span");
        walkingLabel.textContent = "Walking time (minutes)";
        const estimateLabel = document.createElement("span");
        estimateLabel.className = "edit-checkbox-label";
        estimateLabel.append(estimated, " Approximate");
        walkingField.append(walkingLabel, walking, estimateLabel);
        const priceMin = makeInput("number", restaurant.priceMin, { min: 0, max: 5000, placeholder: "Not set" });
        const priceMax = makeInput("number", restaurant.priceMax, { min: 0, max: 5000, placeholder: "Not set" });
        const vegetarian = document.createElement("select");
        for (const [value, labelText] of [["unknown", "Not confirmed"], ["yes", "Yes"], ["no", "No"]]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = labelText;
            vegetarian.append(option);
        }
        vegetarian.value = restaurant.vegetarian || "unknown";
        const hours = makeInput("textarea", restaurant.hours ? formatWeeklyHours(restaurant.hours) : "", {
            placeholder: "Mon-Fri 11:00-21:00; Sat 12:00-22:00; Sun closed"
        });
        fields.append(
            createEditorField("Place name", name),
            createEditorField("Address", address),
            createEditorField("Place type", category),
            walkingField,
            createEditorField("Minimum price (kr)", priceMin),
            createEditorField("Maximum price (kr)", priceMax),
            createEditorField("Vegetarian options", vegetarian),
            createEditorField("Weekly opening hours (leave blank if unknown)", hours)
        );

        const actions = document.createElement("div");
        actions.className = "edit-actions";
        const saveButton = document.createElement("button");
        saveButton.className = "add-button";
        saveButton.type = "submit";
        saveButton.textContent = "Save changes";
        const cancelButton = document.createElement("button");
        cancelButton.className = "cancel-edit-button";
        cancelButton.type = "button";
        cancelButton.textContent = "Cancel";
        const message = document.createElement("p");
        message.className = "form-message edit-message";
        message.setAttribute("aria-live", "polite");
        actions.append(saveButton, cancelButton);
        form.append(fields, actions, message);

        cancelButton.addEventListener("click", () => form.remove());
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            message.textContent = "";
            message.classList.remove("error");
            try {
                const cleanName = name.value.trim();
                if (!cleanName) throw new Error("Place name is required.");
                const walkMinutes = walking.value ? Number(walking.value) : null;
                const minimum = priceMin.value ? Number(priceMin.value) : null;
                const maximum = priceMax.value ? Number(priceMax.value) : null;
                if (walkMinutes !== null && (!Number.isInteger(walkMinutes) || walkMinutes < 1 || walkMinutes > 120)) {
                    throw new Error("Walking time must be between 1 and 120 minutes.");
                }
                for (const price of [minimum, maximum]) {
                    if (price !== null && (!Number.isFinite(price) || price < 0 || price > 5000)) {
                        throw new Error("Prices must be between 0 and 5,000 kr.");
                    }
                }
                if (minimum !== null && maximum !== null && minimum > maximum) {
                    throw new Error("Minimum price cannot be higher than maximum price.");
                }
                const hoursText = hours.value.trim();
                const parsedHours = hoursText ? parseWeeklyHours(hoursText) : null;
                // Compare day by day: the parsed object's key order differs from the saved data's.
                const hoursChanged = !(parsedHours && restaurant.hours
                    ? DAY_KEYS.every((day) => sameValue(parsedHours[day], restaurant.hours[day]))
                    : parsedHours == null && restaurant.hours == null);
                const updatedHours = hoursChanged ? parsedHours : restaurant.hours;
                const pricesChanged = minimum !== restaurant.priceMin || maximum !== restaurant.priceMax;
                const vegetarianChanged = vegetarian.value !== (restaurant.vegetarian || "unknown");
                const updated = {
                    ...restaurant,
                    name: cleanName,
                    address: address.value.trim(),
                    category: category.value === getCategory(restaurant) ? restaurant.category : category.value,
                    walkMinutes,
                    walkIsEstimate: walkMinutes !== null && estimated.checked,
                    priceMin: minimum,
                    priceMax: maximum,
                    ...(pricesChanged ? {
                        priceNote: "",
                        priceSource: minimum === null && maximum === null ? "" : EDITED_IN_APP,
                        priceCheckedAt: null
                    } : {}),
                    vegetarian: vegetarian.value,
                    ...(vegetarianChanged ? {
                        vegetarianNote: vegetarian.value === "yes" ? "Updated in the app" : "",
                        vegetarianSource: ""
                    } : {}),
                    hours: updatedHours,
                    ...(hoursChanged ? { hoursSource: EDITED_IN_APP, hoursCheckedAt: null } : {}),
                    cuisine: restaurant.cuisine || category.value
                };
                const changes = Object.fromEntries(EDITABLE_FIELDS
                    .filter((field) => !sameValue(updated[field], restaurant[field]))
                    .map((field) => [field, updated[field] ?? null]));
                const existingIndex = editedRestaurants.findIndex((edit) => edit.id === restaurant.id);
                if (existingIndex < 0) {
                    editedRestaurants.push({ id: restaurant.id, editFormat: EDIT_FORMAT_VERSION, ...changes });
                } else {
                    editedRestaurants[existingIndex] = { ...editedRestaurants[existingIndex], ...changes };
                }
                Object.assign(restaurant, updated);
                const saved = saveUserData(message);
                const saveMessage = saved
                    ? `${displayRestaurantName(updated)} details saved in this browser.`
                    : message.textContent;
                WINNER_DETAILS.replaceChildren();
                renderRestaurants();
                showToast(saveMessage);
            } catch (error) {
                message.textContent = error.message;
                message.classList.add("error");
            }
        });
        return form;
    }

    // ---- Reviews (shared with lunchbot) ----

    // Loads every place's average, count and newest reviews. The page keeps working if this fails.
    async function loadReviews({ rerender = true } = {}) {
        if (!REVIEWS_API) return;
        try {
            const response = await fetch(REVIEWS_API, { signal: AbortSignal.timeout(10_000) });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
            reviewSummaries = new Map(Object.entries(result.places || {}));
            reviewsState = "ready";
        } catch (error) {
            console.warn("Could not load reviews:", error);
            reviewsState = "failed";
        }
        // Don't throw away a form someone is filling in; the next re-render shows the reviews
        if (rerender && !OPTION_LIST.querySelector("form")) renderRestaurants();
    }

    function stars(rating) {
        return "★".repeat(rating) + "☆".repeat(5 - rating);
    }

    function ratingSummaryText(restaurant) {
        const summary = reviewSummaries.get(restaurant.id);
        if (!summary) return "";
        return `★ ${summary.average.toFixed(1)} · ${summary.count} review${summary.count === 1 ? "" : "s"}`;
    }

    function readReviewerName() {
        try {
            return localStorage.getItem(REVIEWER_NAME_KEY) || "";
        } catch {
            return "";
        }
    }

    function saveReviewerName(name) {
        try {
            localStorage.setItem(REVIEWER_NAME_KEY, name);
        } catch {
            // Only a convenience: the name just won't be filled in next time
        }
    }

    // "Mon-Thu 08:00-18:00 · Fri 08:00-15:00 · Sat-Sun closed": days in a row with the same hours are grouped
    function compactWeeklyHours(hours) {
        const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first
        const text = (day) => {
            const intervals = hours[DAY_KEYS[day]];
            return intervals?.length ? intervals.join(", ") : "closed";
        };
        const groups = [];
        for (const day of order) {
            const last = groups[groups.length - 1];
            if (last && last.text === text(day)) last.to = day;
            else groups.push({ from: day, to: day, text: text(day) });
        }
        return groups.map(({ from, to, text: value }) => {
            const days = from === to ? DAY_NAMES[from].slice(0, 3) : `${DAY_NAMES[from].slice(0, 3)}–${DAY_NAMES[to].slice(0, 3)}`;
            return `${days} ${value}`;
        }).join(" · ");
    }

    // "Menu & prices" dropdown: the menu examples as a list, then what's vegetarian. Null when there's nothing to show.
    const openMenuIds = new Set();

    // Turns menu notes like "Meals: A 59 kr, B 89 kr" or "Basilika Wok 109 kr" into neat name / price rows
    function createMenuList(parts) {
        const list = document.createElement("div");
        list.className = "menu-list";
        const dish = /^(.+?)\s+(\d+(?:\s*[-–]\s*\d+)?\s*kr)(?:\s*\(.*\))?\.?$/;
        const addRow = (name, price) => {
            const row = document.createElement("div");
            row.className = "menu-row";
            const nameText = document.createElement("span");
            nameText.textContent = name.charAt(0).toUpperCase() + name.slice(1);
            const priceText = document.createElement("span");
            priceText.className = "menu-price";
            priceText.textContent = price.replace(/\s*[-–]\s*/, "–");
            row.append(nameText, priceText);
            list.append(row);
        };
        for (const fullPart of parts) {
            // Leave out side notes in brackets at the end, e.g. "(official site: both kitchens share one menu)"
            const part = fullPart.replace(/\s*\([^()]*\)\.?$/, "");
            const headingMatch = /^([^:]{3,60}):\s*(.+)$/.exec(part);
            const [, heading, rest] = headingMatch && !/\d\s*kr/.test(headingMatch[1]) ? headingMatch : [null, "", part];
            const pieces = rest.split(/,\s*/);
            const allDishes = pieces.length > 1 && pieces.every((piece) => dish.test(piece));
            if (heading) {
                const title = document.createElement("div");
                title.className = "menu-heading";
                title.textContent = heading;
                list.append(title);
            }
            if (allDishes) {
                for (const piece of pieces) addRow(...dish.exec(piece).slice(1, 3));
            } else if (dish.test(rest)) {
                addRow(...dish.exec(rest).slice(1, 3));
            } else {
                const line = document.createElement("div");
                line.className = "menu-line";
                line.textContent = rest.charAt(0).toUpperCase() + rest.slice(1);
                list.append(line);
            }
        }
        return list;
    }

    function createMenuDropdown(restaurant) {
        const dishes = (restaurant.priceNote || "").split(/;\s*/).map((part) => part.trim()).filter(Boolean);
        const vegetarianText = restaurant.vegetarian === "yes" ? restaurant.vegetarianNote : "";
        if (!dishes.length && !vegetarianText) return null;

        const dropdown = document.createElement("details");
        dropdown.className = "detail-dropdown";
        dropdown.open = openMenuIds.has(restaurant.id);
        dropdown.addEventListener("toggle", () => {
            if (dropdown.open) openMenuIds.add(restaurant.id);
            else openMenuIds.delete(restaurant.id);
        });
        const toggle = document.createElement("summary");
        toggle.textContent = dishes.length ? "Menu & prices" : "Vegetarian options";
        dropdown.append(toggle);

        const body = document.createElement("div");
        body.className = "dropdown-body";
        if (dishes.length) body.append(createMenuList(dishes));
        if (vegetarianText) {
            const vegetarian = document.createElement("p");
            vegetarian.className = "menu-veg";
            const label = document.createElement("strong");
            label.textContent = "Vegetarian: ";
            vegetarian.append(label, vegetarianText);
            body.append(vegetarian);
        }
        const source = isWebLink(restaurant.priceSource) ? restaurant.priceSource
            : isWebLink(restaurant.vegetarianSource) ? restaurant.vegetarianSource : "";
        if (source) body.append(createLink(source, "See the full menu"));
        dropdown.append(body);
        return dropdown;
    }

    // Which places have their reviews dropdown open, so it stays open when the list re-renders
    const openReviewIds = new Set();

    function createReviewSection(restaurant) {
        const summary = reviewSummaries.get(restaurant.id);
        if (!summary) return null;

        const dropdown = document.createElement("details");
        dropdown.className = "detail-dropdown review-dropdown";
        dropdown.open = openReviewIds.has(restaurant.id);
        dropdown.addEventListener("toggle", () => {
            if (dropdown.open) openReviewIds.add(restaurant.id);
            else openReviewIds.delete(restaurant.id);
        });
        const toggle = document.createElement("summary");
        const summaryStars = document.createElement("span");
        summaryStars.className = "review-stars";
        summaryStars.textContent = stars(Math.round(summary.average));
        summaryStars.setAttribute("aria-hidden", "true");
        toggle.append(summaryStars, ` ${summary.average.toFixed(1)} · ${summary.count} review${summary.count === 1 ? "" : "s"}`);
        dropdown.append(toggle);

        const list = document.createElement("div");
        list.className = "review-list";
        const dateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: data.timezone, day: "numeric", month: "short" });
        for (const review of summary.recent || []) {
            const item = document.createElement("div");
            item.className = "review-item";
            const meta = document.createElement("div");
            meta.className = "review-meta";
            const rating = document.createElement("span");
            rating.className = "review-stars";
            rating.textContent = stars(review.rating);
            rating.setAttribute("aria-label", `${review.rating} out of 5`);
            const name = document.createElement("strong");
            name.textContent = review.name;
            meta.append(rating, name);
            if (review.date) {
                const date = document.createElement("span");
                date.className = "detail-muted";
                date.textContent = dateFormat.format(new Date(review.date));
                meta.append(date);
            }
            item.append(meta);
            if (review.comment) {
                const comment = document.createElement("p");
                comment.className = "review-comment";
                comment.textContent = review.comment;
                item.append(comment);
            }
            list.append(item);
        }
        if (summary.count > (summary.recent || []).length) {
            const more = document.createElement("span");
            more.className = "detail-muted";
            more.textContent = `Showing the ${summary.recent.length} newest. Ask lunchbot in Slack for the rest.`;
            list.append(more);
        }
        dropdown.append(list);
        return dropdown;
    }

    function createReviewForm(restaurant, onClose) {
        const form = document.createElement("form");
        form.className = "edit-form review-form";
        const fields = document.createElement("div");
        fields.className = "edit-fields";

        const name = document.createElement("input");
        name.type = "text";
        name.maxLength = 40;
        name.required = true;
        name.placeholder = "Shown with your review";
        name.value = readReviewerName();
        const rating = document.createElement("select");
        rating.required = true;
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Choose…";
        rating.append(placeholder);
        for (const value of [5, 4, 3, 2, 1]) {
            const option = document.createElement("option");
            option.value = String(value);
            option.textContent = `${stars(value)} ${value} – ${RATING_LABELS[value]}`;
            rating.append(option);
        }
        const comment = document.createElement("textarea");
        comment.rows = 3;
        comment.maxLength = 500;
        comment.placeholder = "What did you have? Would you go back? (optional)";
        fields.append(
            createEditorField("Your name", name),
            createEditorField("Rating", rating),
            createEditorField("Comment", comment)
        );

        const actions = document.createElement("div");
        actions.className = "edit-actions";
        const saveButton = document.createElement("button");
        saveButton.className = "add-button";
        saveButton.type = "submit";
        saveButton.textContent = "Post review";
        const cancelButton = document.createElement("button");
        cancelButton.className = "cancel-edit-button";
        cancelButton.type = "button";
        cancelButton.textContent = "Cancel";
        const message = document.createElement("p");
        message.className = "form-message edit-message";
        message.setAttribute("aria-live", "polite");
        actions.append(saveButton, cancelButton);
        form.append(fields, actions, message);

        cancelButton.addEventListener("click", onClose);
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            message.classList.remove("error");
            const cleanName = name.value.trim().replace(/\s+/g, " ");
            if (!cleanName) {
                message.textContent = "Add your name.";
                message.classList.add("error");
                return;
            }
            saveButton.disabled = true;
            message.textContent = "Saving…";
            try {
                const response = await fetch(REVIEWS_API, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        restaurantId: restaurant.id,
                        name: cleanName,
                        rating: Number(rating.value),
                        comment: comment.value.trim()
                    }),
                    signal: AbortSignal.timeout(15_000)
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(result.error || `The review could not be saved (HTTP ${response.status}).`);
                saveReviewerName(cleanName);
                onClose();
                await loadReviews({ rerender: false });
                renderRestaurants();
                showToast(`Thanks, ${cleanName}! Your review of ${displayRestaurantName(restaurant)} is saved.`);
            } catch (error) {
                message.textContent = error.name === "TimeoutError"
                    ? "Saving took too long. Check your connection and try again."
                    : error instanceof TypeError
                        ? "Couldn't reach the review server. Check your connection and try again."
                        : error.message;
                message.classList.add("error");
                saveButton.disabled = false;
            }
        });
        return form;
    }

    // Every lunch spot is one row. Extras fill the free space and are dropped, one at a time, only where a card
    // is too crowded to show its whole name: first the place type, then the walk time, then today's hours.
    const CROWDED_STEPS = ["hide-badge", "hide-walk", "hide-hours"];

    function fitCardRows() {
        const items = [...OPTION_LIST.querySelectorAll(":scope > li[data-brand]")];
        items.forEach((item) => item.classList.remove(...CROWDED_STEPS));
        const isCrowded = (item) => {
            const name = item.querySelector(".option-name");
            const heading = item.querySelector(".option-heading");
            return name.scrollWidth > name.clientWidth + 1 || heading.scrollWidth > heading.clientWidth + 1;
        };
        let crowded = items;
        for (const step of CROWDED_STEPS) {
            crowded = crowded.filter(isCrowded); // measure all first, then change, so the page only re-lays out once per step
            if (!crowded.length) break;
            crowded.forEach((item) => item.classList.add(step));
        }
    }

    let fitTimer = null;
    function refitOnResize() {
        window.clearTimeout(fitTimer);
        fitTimer = window.setTimeout(fitCardRows, 120);
    }

    function renderRestaurants(now = getStockholmTime()) {
        hoveredRestaurantIndex = -1;
        WHEEL_TOOLTIP.hidden = true;
        buildBrands();
        const filtered = getFilteredRestaurants(now).sort((first, second) => compareByRelevance(first, second, now));
        const groups = groupBranches(filtered);
        const matchingPlaces = restaurants.filter((restaurant) => !hiddenIds.includes(restaurant.id)
            && matchesOtherFilters(restaurant, now));
        const matchingPlacesAreHidden = matchingPlaces.length === 0
            && restaurants.some((restaurant) => hiddenIds.includes(restaurant.id) && matchesOtherFilters(restaurant, now));
        const canSpin = (restaurant) => {
            const state = getStatus(restaurant, now).state;
            return state === "open"
                || state === "unknown"
                || (FILTERS.showClosed.checked && state === "closed");
        };
        // One slice per brand: the picked (or nearest) branch among those that can be spun
        const listEligible = groups
            .map((branches) => branches.filter(canSpin))
            .filter((branches) => branches.length)
            .map(pickBranch);
        // Keep the wheel's slices fixed mid-spin so it lands on the announced winner;
        // the finished spin re-renders with the latest filters.
        // The wheel goes alphabetically (clockwise from the pointer); the list below keeps "most info first"
        if (!spinning) {
            eligibleRestaurants = [...listEligible].sort((first, second) =>
                NAME_COLLATOR.compare(displayRestaurantName(first), displayRestaurantName(second)));
        }
        const wheelIsEmpty = !spinning && listEligible.length === 0;
        RESULT.hidden = wheelIsEmpty;
        WHEEL_EMPTY.hidden = !wheelIsEmpty;
        WHEEL.closest(".wheel-frame").classList.toggle("is-empty", wheelIsEmpty);
        if (wheelIsEmpty && filtered.length === 0) {
            WHEEL_EMPTY_TITLE.textContent = matchingPlacesAreHidden ? "Your shortlist is hidden" : "No spots match";
            WHEEL_EMPTY_MESSAGE.textContent = matchingPlacesAreHidden
                ? "Restore removed places to put them back on the wheel."
                : "Try clearing or loosening a filter.";
            CLEAR_WHEEL_FILTERS.hidden = false;
            CLEAR_WHEEL_FILTERS.textContent = matchingPlacesAreHidden ? "Restore removed places" : "Clear filters";
            CLEAR_WHEEL_FILTERS.onclick = matchingPlacesAreHidden
                ? () => restoreHiddenPlaces(restaurants.filter((restaurant) => hiddenIds.includes(restaurant.id)
                    && matchesOtherFilters(restaurant, now)).map((restaurant) => restaurant.id))
                : resetFilters;
        } else if (wheelIsEmpty) {
            WHEEL_EMPTY_TITLE.textContent = "No places to spin";
            WHEEL_EMPTY_MESSAGE.textContent = "Try including closed places to add them to the wheel.";
            CLEAR_WHEEL_FILTERS.hidden = true;
            CLEAR_WHEEL_FILTERS.onclick = null;
        } else {
            CLEAR_WHEEL_FILTERS.hidden = true;
            CLEAR_WHEEL_FILTERS.onclick = null;
        }
        OPTION_LIST.replaceChildren();
        SPIN_BUTTON.disabled = spinning || listEligible.length === 0;
        const openCount = groups.filter((branches) => getStatus(pickBranch(branches), now).state === "open").length;
        const unknownCount = listEligible.filter((restaurant) => getStatus(restaurant, now).state === "unknown").length;
        OPTION_COUNT.textContent = `${listEligible.length} on wheel · ${openCount} open · ${unknownCount} unconfirmed`;
        OPTION_COUNT.setAttribute("aria-label", `${listEligible.length} places on the wheel, ${openCount} open now, ${unknownCount} with unconfirmed hours`);

        if (filtered.length === 0) {
            const empty = document.createElement("li");
            empty.className = "empty-list";
            const message = document.createElement("span");
            message.textContent = matchingPlacesAreHidden
                ? "These places were removed from your shortlist."
                : "No places match these filters.";
            const clearButton = document.createElement("button");
            clearButton.className = "clear-filters-button";
            clearButton.type = "button";
            clearButton.textContent = matchingPlacesAreHidden ? "Restore removed places" : "Clear filters";
            clearButton.addEventListener("click", matchingPlacesAreHidden
                ? () => restoreHiddenPlaces(restaurants.filter((restaurant) => hiddenIds.includes(restaurant.id)
                    && matchesOtherFilters(restaurant, now)).map((restaurant) => restaurant.id))
                : resetFilters);
            empty.append(message, clearButton);
            OPTION_LIST.append(empty);
        }

        groups.forEach((branches) => {
            const restaurant = pickBranch(branches);
            const brand = brandKey(restaurant);
            const status = getStatus(restaurant, now);
            const item = document.createElement("li");
            item.dataset.id = restaurant.id;
            item.dataset.brand = brand;
            item.tabIndex = -1; // so clicking the place on the wheel can open it here
            if (status.state !== "open") item.classList.add("closed");
            if (status.state === "closed" && !FILTERS.showClosed.checked) item.classList.add("not-on-wheel");

            const heading = document.createElement("div");
            heading.className = "option-heading";
            const name = document.createElement("span");
            name.className = "option-name";
            name.textContent = displayRestaurantName(restaurant);
            const categoryBadge = document.createElement("span");
            categoryBadge.className = "category-badge";
            categoryBadge.textContent = getCategory(restaurant);
            const statusDot = document.createElement("span");
            statusDot.className = `status-dot ${status.state}`;
            statusDot.setAttribute("role", "img");
            statusDot.setAttribute("aria-label", status.state === "open"
                ? "Open now"
                : status.state === "closed" ? "Closed now" : "Opening hours unconfirmed");
            statusDot.title = status.state === "open"
                ? "Open now"
                : status.state === "closed" ? "Closed now" : "Opening hours unconfirmed";
            const openArrow = document.createElement("span");
            openArrow.className = "open-arrow";
            openArrow.setAttribute("aria-hidden", "true");
            openArrow.textContent = "\u25BE";
            // Badge, rating, dot and arrow stay together so they never wrap apart
            const meta = document.createElement("span");
            meta.className = "option-meta";
            meta.append(categoryBadge, statusDot, openArrow);
            heading.append(name, meta);

            // In the card's empty space: today's opening hours and the walk, so you don't have to open it
            const glance = document.createElement("span");
            glance.className = "option-glance";
            const todaysHours = restaurant.hours?.[DAY_KEYS[now.day]];
            const hoursText = document.createElement("span");
            if (!Array.isArray(todaysHours)) hoursText.textContent = "Hours unknown";
            else if (!todaysHours.length) {
                hoursText.textContent = "Closed today";
                hoursText.className = "glance-closed";
            } else {
                // Just one slot: the one open now, else the next one today, else the first (the card has them all)
                const slots = todaysHours.map((range) => ({ range, ...parseInterval(range) }));
                const slot = slots.find((s) => now.minutes >= s.start && now.minutes < s.end)
                    || slots.find((s) => s.start > now.minutes) || slots[0];
                hoursText.textContent = slot.range.replace(/-/g, "\u2013");
            }
            glance.append(hoursText);
            if (restaurant.walkMinutes) {
                const walk = document.createElement("span");
                walk.className = "glance-walk";
                walk.textContent = ` \u00b7 ${restaurant.walkIsEstimate ? "~" : ""}${restaurant.walkMinutes} min`;
                walk.title = "Walking time";
                glance.append(walk);
            }
            heading.append(glance);

            // Click or tap a lunch spot to open it, and again to close it
            heading.tabIndex = 0;
            heading.setAttribute("role", "button");
            const setOpen = (open) => {
                item.classList.toggle("open", open);
                heading.setAttribute("aria-expanded", String(open));
                if (open) openCards.add(brand);
                else openCards.delete(brand);
            };
            setOpen(openCards.has(brand));
            item.addEventListener("click", (event) => {
                // Buttons, links, menus and anything inside the opened details work as usual
                if (event.target.closest("button, a, select, input, textarea, label, summary, .option-details")) return;
                setOpen(!item.classList.contains("open"));
            });
            heading.addEventListener("keydown", (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                setOpen(!item.classList.contains("open"));
            });
            const ratingText = ratingSummaryText(restaurant);
            if (ratingText) {
                const ratingBadge = document.createElement("span");
                ratingBadge.className = "rating-badge";
                ratingBadge.textContent = `★ ${reviewSummaries.get(restaurant.id).average.toFixed(1)}`;
                ratingBadge.title = ratingText;
                categoryBadge.after(ratingBadge);
            }

            const actions = document.createElement("div");
            actions.className = "option-actions";
            const editButton = document.createElement("button");
            editButton.className = "edit-button";
            editButton.type = "button";
            editButton.textContent = "Edit";
            editButton.setAttribute("aria-label", `Edit ${displayRestaurantName(restaurant)}`);
            editButton.setAttribute("aria-expanded", "false");
            editButton.addEventListener("click", () => {
                const currentForm = details.querySelector(".edit-form:not(.review-form)");
                if (currentForm) {
                    currentForm.remove();
                    editButton.textContent = "Edit";
                    editButton.setAttribute("aria-expanded", "false");
                    return;
                }
                setOpen(true);
                details.append(createEditForm(restaurant));
                editButton.textContent = "Close editor";
                editButton.setAttribute("aria-expanded", "true");
            });

            const removeButton = document.createElement("button");
            removeButton.className = "remove-button";
            removeButton.type = "button";
            removeButton.textContent = "×";
            removeButton.setAttribute("aria-label", `Remove ${displayRestaurantName(restaurant)}`);
            removeButton.addEventListener("click", () => {
                if (spinning) return;
                const removedIds = branches.map((branch) => branch.id);
                hiddenIds.push(...removedIds);
                saveUserData();
                WINNER_DETAILS.replaceChildren();
                RESULT.textContent = "Restaurant removed from your list.";
                const undoButton = document.createElement("button");
                undoButton.className = "undo-button";
                undoButton.type = "button";
                undoButton.textContent = "Undo";
                undoButton.addEventListener("click", () => {
                    hiddenIds = hiddenIds.filter((id) => !removedIds.includes(id));
                    saveUserData();
                    WINNER_DETAILS.replaceChildren();
                    renderRestaurants();
                    RESULT.textContent = `${displayRestaurantName(restaurant)} is back on your list.`;
                });
                WINNER_DETAILS.append(undoButton);
                renderRestaurants();
            });
            const canReview = REVIEWS_API && reviewableIds.has(restaurant.id);
            if (canReview) {
                const reviewButton = document.createElement("button");
                reviewButton.className = "edit-button";
                reviewButton.type = "button";
                reviewButton.textContent = "Review";
                reviewButton.setAttribute("aria-label", `Review ${displayRestaurantName(restaurant)}`);
                reviewButton.setAttribute("aria-expanded", "false");
                const closeReviewForm = () => {
                    details.querySelector(".review-form")?.remove();
                    reviewButton.textContent = "Review";
                    reviewButton.setAttribute("aria-expanded", "false");
                };
                reviewButton.addEventListener("click", () => {
                    if (details.querySelector(".review-form")) {
                        closeReviewForm();
                        return;
                    }
                    const form = createReviewForm(restaurant, closeReviewForm);
                    setOpen(true);
                    details.append(form);
                    reviewButton.textContent = "Close review";
                    reviewButton.setAttribute("aria-expanded", "true");
                    form.querySelector(form.querySelector("input").value ? "select" : "input").focus();
                });
                actions.append(reviewButton);
            }
            actions.append(editButton, removeButton);

            const details = document.createElement("div");
            details.className = "option-details";

            // The key facts on one line: open or not, how far, how much
            const summaryLine = document.createElement("div");
            summaryLine.className = "detail-summary";
            const statusLine = document.createElement("span");
            statusLine.className = `status-line ${status.state}`;
            statusLine.textContent = status.label;
            summaryLine.append(statusLine, ` · ${restaurant.walkMinutes
                ? `${restaurant.walkIsEstimate ? "~" : ""}${restaurant.walkMinutes} min walk`
                : "walking time not added"} · ${priceText(restaurant)}`);
            const links = document.createElement("div");
            links.className = "detail-links";
            links.append(
                createLink(directionsUrl(restaurant), "Directions", "walk-link"),
                createLink(googleMapsUrl(restaurant), "Google Maps")
            );
            const topRow = document.createElement("div");
            topRow.className = "detail-top";
            topRow.append(summaryLine, links);
            details.append(topRow);

            // Chains: pick which branch (address) the card shows
            if (branches.length > 1) {
                const picker = document.createElement("label");
                picker.className = "branch-picker";
                const select = document.createElement("select");
                select.setAttribute("aria-label", `Choose which ${displayRestaurantName(restaurant)}`);
                for (const branch of [...branches].sort((a, b) => (a.walkMinutes ?? 999) - (b.walkMinutes ?? 999))) {
                    const option = document.createElement("option");
                    option.value = branch.id;
                    const branchState = getStatus(branch, now).state;
                    option.textContent = [
                        shortAddress(branch) || branch.name,
                        branch.walkMinutes ? `${branch.walkIsEstimate ? "~" : ""}${branch.walkMinutes} min` : "",
                        branchState === "closed" ? "closed now" : ""
                    ].filter(Boolean).join(" · ");
                    select.append(option);
                }
                select.value = restaurant.id;
                select.addEventListener("change", () => {
                    selectedBranches.set(brand, select.value);
                    renderRestaurants();
                    // Re-rendering rebuilds the card, so keep it open on the new branch
                    OPTION_LIST.querySelector(`li[data-brand="${CSS.escape(brand)}"] .branch-picker select`)?.focus();
                });
                picker.append(`${branches.length} places: `, select);
                details.append(picker);
            } else if (isChain(restaurant) && shortAddress(restaurant)) {
                const address = document.createElement("span");
                address.className = "branch-picker";
                address.textContent = shortAddress(restaurant);
                details.append(address);
            }

            // A few small tags: today's hours, vegetarian, unchecked details
            const tags = document.createElement("div");
            tags.className = "detail-tags";
            const addTag = (text, className = "", title = "") => {
                const tag = document.createElement("span");
                tag.className = `detail-tag ${className}`.trim();
                tag.textContent = text;
                if (title) tag.title = title;
                tags.append(tag);
            };
            if (restaurant.hours) {
                const today = restaurant.hours[DAY_KEYS[now.day]];
                addTag(`Today ${today?.length ? today.join(", ").replace(/-/g, "–") : "closed"}`, "",
                    compactWeeklyHours(restaurant.hours).replace(/-/g, "–"));
            }
            if (restaurant.vegetarian === "yes") addTag("Vegetarian options", "veg");
            else if (restaurant.vegetarian === "no") addTag("No vegetarian options");
            if (restaurant.unverified) addTag("Details unchecked", "muted", "From OpenStreetMap, not checked by hand yet");
            if (tags.childElementCount) details.append(tags);

            if (restaurant.notice) {
                const notice = document.createElement("span");
                notice.className = "place-notice";
                notice.textContent = restaurant.notice;
                details.append(notice);
            }

            const dropdowns = document.createElement("div");
            dropdowns.className = "detail-dropdowns";
            const menu = createMenuDropdown(restaurant);
            if (menu) dropdowns.append(menu);
            const reviews = canReview ? createReviewSection(restaurant) : null;
            if (reviews) dropdowns.append(reviews);
            if (dropdowns.childElementCount) details.append(dropdowns);
            item.append(heading, actions, details);
            OPTION_LIST.append(item);
        });
        fitCardRows();
        updateResetVisibility();

        if (spinning) {
            // The spin animation owns the result text until it finishes.
        } else if (!WINNER_DETAILS.hasChildNodes()) {
            RESULT.textContent = ""; // the wheel itself says when nothing can be spun
        }

        drawWheel();
    }

    function animateIdle(now) {
        const elapsed = lastIdleFrame === null ? 0 : Math.min(now - lastIdleFrame, 50);
        lastIdleFrame = now;
        // The wheel drifts slowly while idle, but holds still on the winner while its result card is showing
        if (!spinning && hoveredRestaurantIndex < 0 && WINNER_CARD.hidden && !prefersReducedMotion.matches && eligibleRestaurants.length > 0) {
            rotation = (rotation + elapsed * (Math.PI * 2 / 60000)) % (Math.PI * 2);
            drawWheel();
        }

        requestAnimationFrame(animateIdle);
    }

    // Filters are remembered in this browser between visits (not the search text)
    function filterSettings() {
        return {
            vegetarian: FILTERS.vegetarian.checked,
            showClosed: FILTERS.showClosed.checked,
            showUnpriced: FILTERS.showUnpriced.checked,
            showUnconfirmed: FILTERS.showUnconfirmed.checked,
            walk: FILTERS.walk.value,
            price: FILTERS.price.value,
            categories: CATEGORY_FILTERS.filter((input) => input.checked).map((input) => input.value)
        };
    }

    const DEFAULT_FILTERS = JSON.stringify({
        vegetarian: false, showClosed: true, showUnpriced: true, showUnconfirmed: true, walk: "", price: "", categories: []
    });

    function saveFilterSettings() {
        try {
            localStorage.setItem(FILTER_SETTINGS_KEY, JSON.stringify(filterSettings()));
        } catch {
            // only a convenience
        }
    }

    function restoreFilterSettings() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(FILTER_SETTINGS_KEY) || "null");
        } catch {
            return;
        }
        if (!saved || typeof saved !== "object") return;
        for (const key of ["vegetarian", "showClosed", "showUnpriced", "showUnconfirmed"]) {
            if (typeof saved[key] === "boolean") FILTERS[key].checked = saved[key];
        }
        for (const key of ["walk", "price"]) {
            if ([...FILTERS[key].options].some((option) => option.value === saved[key])) FILTERS[key].value = saved[key];
        }
        if (Array.isArray(saved.categories)) {
            CATEGORY_FILTERS.forEach((input) => {
                input.checked = saved.categories.includes(input.value);
            });
        }
        updateCategoryFilterSummary();
    }

    // The "Reset filters" link only shows when something differs from the defaults
    function updateResetVisibility() {
        RESET_FILTERS.hidden = JSON.stringify(filterSettings()) === DEFAULT_FILTERS && !FILTERS.search.value.trim();
    }

    function resetFilters() {
        FILTERS.search.value = "";
        FILTERS.showClosed.checked = true;
        FILTERS.showUnpriced.checked = true;
        FILTERS.showUnconfirmed.checked = true;
        FILTERS.vegetarian.checked = false;
        FILTERS.walk.value = "";
        FILTERS.price.value = "";
        CATEGORY_FILTERS.forEach((input) => {
            input.checked = false;
        });
        updateCategoryFilterSummary();
        WINNER_DETAILS.replaceChildren();
        saveFilterSettings();
        renderRestaurants();
    }

    function updateCategoryFilterSummary() {
        const selected = CATEGORY_FILTERS.filter((input) => input.checked)
            .map((input) => input.parentElement.textContent.trim());
        CATEGORY_FILTER_SUMMARY.textContent = selected.length === 0
            ? "All place types"
            : selected.length <= 2 ? selected.join(" + ") : `${selected.length} types selected`;
    }

    function restoreHiddenPlaces(ids) {
        const restoredIds = new Set(ids);
        hiddenIds = hiddenIds.filter((id) => !restoredIds.has(id));
        saveUserData();
        WINNER_DETAILS.replaceChildren();
        renderRestaurants();
    }

    // ---- The spin result: a card over the wheel ----

    function hideWinnerCard() {
        WINNER_CARD.hidden = true;
        WINNER_CARD.replaceChildren();
    }

    // Opens a place's card in the list and scrolls to it
    function showInList(restaurant) {
        const brand = brandKey(restaurant);
        selectedBranches.set(brand, restaurant.id);
        openCards.add(brand);
        renderRestaurants();
        const item = OPTION_LIST.querySelector(`li[data-brand="${CSS.escape(brand)}"]`);
        if (!item) return;
        item.scrollIntoView({ behavior: prefersReducedMotion.matches ? "auto" : "smooth", block: "center" });
        item.querySelector(".option-heading")?.focus({ preventScroll: true });
    }

    function showWinnerCard(restaurant) {
        const now = getStockholmTime();
        const status = getStatus(restaurant, now);
        const card = document.createDocumentFragment();

        const close = document.createElement("button");
        close.type = "button";
        close.className = "winner-close";
        close.textContent = "\u00d7";
        close.setAttribute("aria-label", "Close");
        close.addEventListener("click", hideWinnerCard);

        const kicker = document.createElement("p");
        kicker.className = "winner-kicker";
        kicker.textContent = "Today you're having";
        const name = document.createElement("h2");
        name.className = "winner-name";
        name.textContent = displayRestaurantName(restaurant);
        card.append(close, kicker, name);

        if (isChain(restaurant) && shortAddress(restaurant)) {
            const address = document.createElement("p");
            address.className = "winner-address";
            address.textContent = shortAddress(restaurant);
            card.append(address);
        }

        const todaysHours = restaurant.hours?.[DAY_KEYS[now.day]];
        const facts = document.createElement("p");
        facts.className = "winner-facts";
        const state = document.createElement("span");
        state.className = `status-line ${status.state}`;
        state.textContent = status.state === "open" ? "Open now" : status.state === "closed" ? "Closed now" : "Hours unconfirmed";
        facts.append(state, ...[
            Array.isArray(todaysHours) ? (todaysHours.length ? `Today ${todaysHours.join(", ").replace(/-/g, "\u2013")}` : "Closed today") : "",
            restaurant.walkMinutes ? `${restaurant.walkIsEstimate ? "~" : ""}${restaurant.walkMinutes} min walk` : "",
            priceText(restaurant)
        ].filter(Boolean).map((text) => ` \u00b7 ${text}`));
        card.append(facts);

        const extras = [ratingSummaryText(restaurant), restaurant.vegetarian === "yes" ? "Vegetarian options" : ""].filter(Boolean);
        if (extras.length) {
            const tags = document.createElement("p");
            tags.className = "winner-tags";
            for (const text of extras) {
                const tag = document.createElement("span");
                tag.textContent = text;
                tags.append(tag);
            }
            card.append(tags);
        }

        const actions = document.createElement("div");
        actions.className = "winner-actions";
        const directions = createLink(directionsUrl(restaurant), "Directions", "winner-button primary");
        const details = document.createElement("button");
        details.type = "button";
        details.className = "winner-button";
        details.textContent = "See details";
        details.addEventListener("click", () => {
            hideWinnerCard();
            showInList(restaurant);
        });
        const again = document.createElement("button");
        again.type = "button";
        again.className = "winner-button";
        again.textContent = "Spin again";
        again.addEventListener("click", spin);
        actions.append(directions, details, again);
        card.append(actions);

        WINNER_CARD.replaceChildren(card);
        WINNER_CARD.hidden = false;
        // Focus the card itself (not a button), so keyboard and screen-reader users land on the result without a loud focus ring
        WINNER_CARD.focus({ preventScroll: true });
    }

    function spin() {
        if (spinning || eligibleRestaurants.length === 0) return;
        spinning = true;
        hoveredRestaurantIndex = -1;
        WHEEL_TOOLTIP.hidden = true;
        SPIN_BUTTON.disabled = true;
        RESULT.textContent = "";
        WINNER_DETAILS.replaceChildren();
        hideWinnerCard();

        const selection = [...eligibleRestaurants];
        const winner = Math.floor(Math.random() * selection.length);
        const slice = (Math.PI * 2) / selection.length;
        const desiredRotation = ((-(winner + 0.5) * slice) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        const turns = 5 + Math.floor(Math.random() * 3);
        const extraTurns = Math.ceil((rotation - desiredRotation) / (Math.PI * 2)) + turns;
        const startRotation = rotation;
        const endRotation = desiredRotation + extraTurns * Math.PI * 2;
        const duration = 4200;
        const startedAt = performance.now();

        function animate(now) {
            const progress = Math.min((now - startedAt) / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 4);
            rotation = startRotation + (endRotation - startRotation) * eased;
            drawWheel();

            if (progress < 1) {
                requestAnimationFrame(animate);
                return;
            }

            rotation = endRotation % (Math.PI * 2);
            spinning = false;
            const selected = selection[winner];
            RESULT.textContent = `Today you're having ${displayRestaurantName(selected)}!`; // read out by screen readers
            showWinnerCard(selected);
            renderRestaurants();
        }

        requestAnimationFrame(animate);
    }

    function parseTime(value) {
        const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(value);
        if (!match) return null;
        const hours = Number(match[1]);
        const minutes = Number(match[2] || 0);
        if (hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0)) return null;
        return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    }

    function parseWeeklyHours(value) {
        const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        const hours = Object.fromEntries(DAY_KEYS.map((day) => [day, undefined]));
        const statements = value.split(";").map((statement) => statement.trim()).filter(Boolean);

        for (const statement of statements) {
            const match = /^(Daily|Every day|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:\s*-\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))?(?:\s*,\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:\s*-\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))?)*)\s+(.+)$/i.exec(statement);
            if (!match) throw new Error(`Could not read "${statement}". Use entries like Mon-Fri 11:00-21:00; Sun closed.`);

            const dayPart = match[1];
            const timePart = match[2].trim();
            const selectedDays = [];
            if (/^(daily|every day)$/i.test(dayPart)) {
                selectedDays.push(...dayNames);
            } else {
                for (const group of dayPart.split(",")) {
                    const range = group.trim().split(/\s*-\s*/);
                    const first = dayNames.findIndex((day) => day.toLowerCase() === range[0].toLowerCase());
                    const last = range[1] ? dayNames.findIndex((day) => day.toLowerCase() === range[1].toLowerCase()) : first;
                    if (first < 0 || last < 0) throw new Error(`Unknown day in "${dayPart}".`);
                    for (let index = first; ; index = (index + 1) % dayNames.length) {
                        selectedDays.push(dayNames[index]);
                        if (index === last) break;
                    }
                }
            }

            let intervals = [];
            if (!/^closed$/i.test(timePart)) {
                intervals = timePart.split(/\s*,\s*/).map((range) => {
                    const rangeMatch = /^(\d{1,2}(?::\d{2})?)\s*[-–]\s*(\d{1,2}(?::\d{2})?)$/.exec(range);
                    if (!rangeMatch) throw new Error(`Could not read opening time "${range}". Use 11:00-21:00 or closed.`);
                    const start = parseTime(rangeMatch[1]);
                    const end = parseTime(rangeMatch[2]);
                    if (!start || !end) throw new Error(`Invalid time in "${range}".`);
                    return `${start}-${end}`;
                });
            }

            for (const day of selectedDays) {
                hours[day.toLowerCase()] = intervals;
            }
        }

        const missingDays = dayNames.filter((day) => hours[day.toLowerCase()] === undefined);
        if (missingDays.length) throw new Error(`Please include every day (or use "Daily"), missing: ${missingDays.join(", ")}.`);
        return hours;
    }

    function nameFromMapUrl(value) {
        try {
            const url = new URL(value);
            const placeIndex = url.pathname.split("/").indexOf("place");
            if (placeIndex >= 0 && url.pathname.split("/")[placeIndex + 1]) {
                return decodeURIComponent(url.pathname.split("/")[placeIndex + 1].replace(/\+/g, " ")).replace(/_/g, " ").trim();
            }
            const query = url.searchParams.get("query") || url.searchParams.get("q");
            if (query) return query.split(",")[0].trim();
            if (url.hostname === "maps.app.goo.gl") return "";
            throw new Error("That link does not look like a Google Maps place or search link.");
        } catch (error) {
            if (error instanceof TypeError) throw new Error("Enter a valid Google Maps link.");
            throw error;
        }
    }

    function validateMapUrl(value) {
        if (!value) return "";
        const url = new URL(value);
        const isGoogleMaps = url.hostname === "maps.app.goo.gl"
            || (url.hostname.endsWith("google.com") && url.pathname.includes("/maps"));
        if (!isGoogleMaps || !["https:", "http:"].includes(url.protocol)) {
            throw new Error("Use a Google Maps place, search, or directions link.");
        }
        return url.href;
    }

    function readFormRestaurant() {
        const name = document.querySelector("#new-name").value.trim();
        if (!name) throw new Error("Enter a restaurant name.");

        const mapUrl = validateMapUrl(document.querySelector("#new-map-link").value.trim());
        const address = document.querySelector("#new-address").value.trim();
        const walkValue = document.querySelector("#new-walk").value;
        const priceValue = document.querySelector("#new-price").value;
        const vegetarian = document.querySelector("#new-vegetarian").value;
        const category = document.querySelector("#new-category").value;
        const hoursText = document.querySelector("#new-hours").value.trim();
        const walkMinutes = walkValue ? Number(walkValue) : null;
        const price = priceValue ? Number(priceValue) : null;
        if (walkMinutes !== null && (!Number.isInteger(walkMinutes) || walkMinutes < 1 || walkMinutes > 120)) {
            throw new Error("Walking time must be between 1 and 120 minutes.");
        }
        if (price !== null && (!Number.isFinite(price) || price < 0 || price > 5000)) {
            throw new Error("Lunch price must be between 0 and 5,000 kr.");
        }

        return {
            id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            address,
            mapUrl,
            walkMinutes,
            priceMin: price,
            priceMax: price,
            category,
            vegetarian,
            vegetarianNote: "",
            hours: hoursText ? parseWeeklyHours(hoursText) : null
        };
    }

    function initialize() {
        data = window.LUNCH_WHEEL_DATA;
        if (!data || !Array.isArray(data.restaurants) || !data.timezone || !data.origin) {
            RESULT.textContent = "Could not load restaurant data. Check that restaurants.js is beside index.html.";
            return;
        }

        customRestaurants = loadJsonFromStorage(STORAGE_KEY, [], (value) => Array.isArray(value)
            && value.every(isStoredRestaurant));
        hiddenIds = loadJsonFromStorage(HIDDEN_KEY, [], (value) => Array.isArray(value)
            && value.every((id) => typeof id === "string"));
        editedRestaurants = loadJsonFromStorage(EDITED_KEY, [], (value) => Array.isArray(value)
            && value.every(isStoredEdit));
        const basesById = new Map([...data.restaurants, ...customRestaurants].map((place) => [place.id, place]));
        if (editedRestaurants.some((edit) => edit.editFormat !== EDIT_FORMAT_VERSION)) {
            editedRestaurants = editedRestaurants.map((edit) => migrateLegacyEdit(edit, basesById.get(edit.id)));
            saveUserData();
        }
        restoreFilterSettings();
        restaurants = applySavedRestaurantEdits([...data.restaurants, ...customRestaurants]);
        reviewableIds = new Set(data.restaurants.map((restaurant) => restaurant.id));

        for (const input of [...Object.values(FILTERS), ...CATEGORY_FILTERS]) {
            input.addEventListener("change", () => {
                if (CATEGORY_FILTERS.includes(input)) updateCategoryFilterSummary();
                WINNER_DETAILS.replaceChildren();
                saveFilterSettings();
                renderRestaurants();
            });
        }
        RESET_FILTERS.addEventListener("click", resetFilters);
        FILTERS.search.addEventListener("input", () => {
            WINNER_DETAILS.replaceChildren();
            renderRestaurants();
        });
        SPIN_BUTTON.addEventListener("click", spin);
        // Pressing anywhere outside the result card closes it (the press still does what it normally does)
        document.addEventListener("pointerdown", (event) => {
            if (!WINNER_CARD.hidden && !WINNER_CARD.contains(event.target)) hideWinnerCard();
        });
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && !WINNER_CARD.hidden) {
                hideWinnerCard();
                return;
            }
            if (event.key !== " " || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
            // Only when not typing or pressing something else that uses Space
            if (event.target.closest("input, textarea, select, button, a, summary, [role=button], [contenteditable]")) return;
            event.preventDefault();
            spin();
        });
        WHEEL.addEventListener("pointermove", updateWheelHover);
        WHEEL.addEventListener("click", searchForWheelSlice);
        WHEEL.addEventListener("pointerleave", () => {
            hoveredRestaurantIndex = -1;
            WHEEL_TOOLTIP.hidden = true;
            drawWheel();
        });
        window.addEventListener("resize", drawWheel);
        window.addEventListener("resize", refitOnResize);

        const mapLink = document.querySelector("#new-map-link");
        mapLink.addEventListener("change", () => {
            if (!mapLink.value.trim()) return;
            try {
                const nameField = document.querySelector("#new-name");
                if (!nameField.value.trim()) {
                    nameField.value = nameFromMapUrl(mapLink.value.trim());
                    nameField.select();
                }
                const match = osmRestaurants.find((place) => namesMatch(place.name, nameField.value.trim()));
                if (match) {
                    document.querySelector("#new-address").value ||= match.address;
                    document.querySelector("#new-walk").value ||= match.walkMinutes;
                    if (match.hours) document.querySelector("#new-hours").value = formatWeeklyHours(match.hours);
                    if (match.vegetarian !== "unknown") {
                        document.querySelector("#new-vegetarian").value = match.vegetarian;
                    }
                    showFormMessage(`Found ${match.name} in nearby OpenStreetMap data. Check the imported details; add a price if known.`);
                } else {
                    showFormMessage("Check the imported name and fill in the address, walking time, price, vegetarian options, and weekly hours.");
                }
            } catch (error) {
                showFormMessage(error.message, true);
            }
        });

        FORM.addEventListener("submit", (event) => {
            event.preventDefault();
            try {
                const restaurant = readFormRestaurant();
                const duplicate = restaurants.find((place) => normalizeName(place.name) === normalizeName(restaurant.name));
                if (duplicate) throw new Error(`${duplicate.name} is already in your list.`);
                customRestaurants.push(restaurant);
                restaurants.push(restaurant);
                saveUserData();
                FORM.reset();
                showFormMessage(restaurant.hours
                    ? "Place added. Its saved hours decide whether it shows as open or closed."
                    : "Place added. Without opening hours it is marked hours-unconfirmed but can still be spun.");
                showToast("Place added to your list.");
                WINNER_DETAILS.replaceChildren();
                renderRestaurants();
            } catch (error) {
                showFormMessage(error.message, true);
            }
        });

        renderRestaurants();
        requestAnimationFrame(animateIdle);
        refreshNearbyData();
        loadReviews();
        window.setInterval(() => {
            // Re-rendering rebuilds the list, so wait while someone is filling in a review or an edit
            if (!spinning && !OPTION_LIST.querySelector("form")) renderRestaurants();
        }, 60_000);
    }

    initialize();
})();
