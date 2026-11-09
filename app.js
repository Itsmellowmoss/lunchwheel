(() => {
    "use strict";

    const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const STORAGE_KEY = "lunch-wheel-custom-restaurants-v1";
    const HIDDEN_KEY = "lunch-wheel-hidden-restaurants-v1";
    const EDITED_KEY = "lunch-wheel-edited-restaurants-v1";
    const OSM_CACHE_KEY = "lunch-wheel-osm-cache-v2";
    const OSM_CACHE_MAX_AGE = 2 * 60 * 60 * 1000;
    const OVERPASS_URL = "https://overpass.kumi.systems/api/interpreter";
    const SEARCH_RADIUS_METERS = 1400;
    const ORIGIN_COORDINATES = [59.3395657, 18.0592044];
    const CATEGORIES = ["Restaurant", "Cafe", "Fast food", "Bakery", "Sandwich shop", "Takeaway", "Brunch"];
    const COLORS = [
        "#f5a04f", "#77b7a3", "#f06f55", "#8eaa6b",
        "#e7c356", "#c96f4a", "#df806f", "#77a9c5",
        "#ed873f", "#649d79", "#f18d68", "#adba61",
        "#d9a83f", "#b95640", "#6eaebb", "#e2a0a0"
    ];
    const COLOR_BY_ID = new Map([
        ["fullmoon-wok", 0],
        ["mowglis-kok", 1],
        ["minako-sushi-odenplan", 4],
        ["eatnam", 2],
        ["crispy-pizza-bistro-vasastan", 7],
        ["tranan", 5],
        ["frankys-vasastaden", 6]
    ]);
    const NAME_COLLATOR = new Intl.Collator("sv", { sensitivity: "base", numeric: true });
    const WHEEL = document.querySelector("#wheel");
    const CONTEXT = WHEEL.getContext("2d");
    const WHEEL_TOOLTIP = document.querySelector("#wheel-tooltip");
    const SPIN_BUTTON = document.querySelector("#spin");
    const RESULT = document.querySelector("#result");
    const WINNER_DETAILS = document.querySelector("#winner-details");
    const WHEEL_EMPTY = document.querySelector("#wheel-empty");
    const WHEEL_EMPTY_TITLE = document.querySelector("#wheel-empty-title");
    const WHEEL_EMPTY_MESSAGE = document.querySelector("#wheel-empty-message");
    const CLEAR_WHEEL_FILTERS = document.querySelector("#clear-wheel-filters");
    const OPTION_LIST = document.querySelector("#option-list");
    const OPTION_COUNT = document.querySelector("#option-count");
    const DATA_NOTE = document.querySelector("#data-note");
    const REFRESH_BUTTON = document.querySelector("#refresh-data");
    const REFRESH_BUTTON_LABEL = REFRESH_BUTTON.innerHTML;
    const FORM = document.querySelector("#add-form");
    const FORM_MESSAGE = document.querySelector("#form-message");
    const FILTERS = {
        search: document.querySelector("#place-search"),
        showClosed: document.querySelector("#filter-closed"),
        showUnpriced: document.querySelector("#filter-unpriced"),
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
    let restaurantColors = new Map();
    let rotation = 0;
    let hoveredRestaurantIndex = -1;
    let spinning = false;
    let lastIdleFrame = null;
    let osmRestaurants = [];
    let osmLookupRunning = false;
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

        const maxWalk = Number(FILTERS.walk.value);
        if (maxWalk && (!restaurant.walkMinutes || restaurant.walkMinutes > maxWalk)) return false;

        const maxPrice = Number(FILTERS.price.value);
        if (maxPrice && (restaurant.priceMax == null || restaurant.priceMax > maxPrice)) return false;
        return true;
    }

    function getFilteredRestaurants(now) {
        return restaurants.filter((restaurant) => !hiddenIds.includes(restaurant.id)
            && matchesOtherFilters(restaurant, now));
    }

    function compareByRelevance(first, second, now) {
        const statusOrder = { open: 0, unknown: 1, closed: 2 };
        const firstOrder = statusOrder[getStatus(first, now).state];
        const secondOrder = statusOrder[getStatus(second, now).state];
        return firstOrder - secondOrder || compareRestaurants(first, second);
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

    function displayRestaurantName(restaurant) {
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

    function colorForRestaurant(restaurant) {
        const color = restaurantColors.get(restaurant.id);
        if (color) return color;
        const assignedColor = COLOR_BY_ID.get(restaurant.id);
        if (assignedColor !== undefined) return COLORS[assignedColor];
        return COLORS[0];
    }

    function assignRestaurantColors() {
        const usedIndexes = new Set(COLOR_BY_ID.values());
        restaurantColors = new Map();

        for (const restaurant of restaurants) {
            const index = COLOR_BY_ID.get(restaurant.id);
            if (index !== undefined) restaurantColors.set(restaurant.id, COLORS[index]);
        }

        let nextIndex = 0;
        const additionalRestaurants = [...restaurants].sort(compareRestaurants);
        for (const restaurant of additionalRestaurants) {
            if (restaurantColors.has(restaurant.id)) continue;
            while (usedIndexes.has(nextIndex)) nextIndex += 1;
            if (nextIndex < COLORS.length) {
                restaurantColors.set(restaurant.id, COLORS[nextIndex]);
                usedIndexes.add(nextIndex);
                nextIndex += 1;
            } else {
                const extraIndex = nextIndex - COLORS.length;
                const families = [24, 34, 43, 14, 5, 96, 112, 132, 190, 202, 350, 52];
                const cycle = Math.floor(extraIndex / families.length);
                const saturation = 56 + cycle % 23;
                const lightness = 54 + Math.floor(cycle / 23) % 25;
                restaurantColors.set(
                    restaurant.id,
                    `hsl(${families[extraIndex % families.length]} ${saturation}% ${lightness}%)`
                );
                nextIndex += 1;
            }
        }
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
            DATA_NOTE.textContent = `Could not read the nearby-data cache: ${error.message}`;
            return null;
        }
    }

    function saveOsmCache(cache) {
        try {
            localStorage.setItem(OSM_CACHE_KEY, JSON.stringify(cache));
            return true;
        } catch (error) {
            DATA_NOTE.textContent = `Nearby data loaded but could not be cached: ${error.message}`;
            return false;
        }
    }

    function formatCacheTime(timestamp) {
        return new Intl.DateTimeFormat("en-GB", { timeZone: data.timezone, dateStyle: "medium", timeStyle: "short" })
            .format(new Date(timestamp));
    }

    async function refreshNearbyData(force = false) {
        if (osmLookupRunning) return;
        const cached = readOsmCache();
        if (cached?.restaurants.length) {
            mergeNearbyRestaurants(cached.restaurants);
            if (!force && Date.now() - cached.fetchedAt < OSM_CACHE_MAX_AGE) {
                DATA_NOTE.textContent = `Starting point: ${data.location}. Nearby OpenStreetMap details cached ${formatCacheTime(cached.fetchedAt)}; opening hours use Stockholm time.`;
                return;
            }
        }

        osmLookupRunning = true;
        REFRESH_BUTTON.disabled = true;
        REFRESH_BUTTON.textContent = "Refreshing…";
        DATA_NOTE.textContent = `Checking OpenStreetMap for nearby places around ${data.location}…`;
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
            const fetchedAt = Date.now();
            mergeNearbyRestaurants(nearby);
            const cachedSuccessfully = saveOsmCache({ fetchedAt, restaurants: nearby });
            const searchStatus = failures.length
                ? `Loaded ${quadrantResults.length - failures.length} of 4 map areas; kept cached places for the rest.`
                : `Checked all 4 map areas.`;
            DATA_NOTE.textContent = cachedSuccessfully
                ? `Starting point: ${data.location}. ${searchStatus} Found ${nearby.length} nearby places within about 20 minutes' walk, checked ${formatCacheTime(fetchedAt)}. Verify details on Google Maps.`
                : `${searchStatus} Found ${nearby.length} nearby places around ${data.location}, but they could not be cached. Verify details on Google Maps.`;
        } catch (error) {
            const detail = controller.signal.aborted
                ? "The nearby search timed out."
                : error.message;
            if (cached?.restaurants.length) {
                DATA_NOTE.textContent = `Could not refresh nearby data (${detail}) Showing cached OpenStreetMap details from ${formatCacheTime(cached.fetchedAt)} and saved restaurant data for ${data.location}.`;
            } else {
                DATA_NOTE.textContent = `Nearby lookup failed (${detail}) Showing saved restaurant data for ${data.location} instead. You can try again with “Refresh nearby data.”`;
            }
        } finally {
            window.clearTimeout(timeout);
            osmLookupRunning = false;
            REFRESH_BUTTON.disabled = false;
            REFRESH_BUTTON.innerHTML = REFRESH_BUTTON_LABEL;
        }
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
        const slice = (Math.PI * 2) / Math.max(eligibleRestaurants.length, 1);
        const showSliceDetails = size >= 390 && eligibleRestaurants.length <= 9;
        const now = showSliceDetails ? getStockholmTime() : null;
        CONTEXT.clearRect(0, 0, size, size);

        eligibleRestaurants.forEach((restaurant, index) => {
            const start = -Math.PI / 2 + rotation + index * slice;
            const end = start + slice;
            const isHovered = !spinning && index === hoveredRestaurantIndex;
            const sliceRadius = radius + (isHovered ? 13 : 0);
            CONTEXT.beginPath();
            CONTEXT.moveTo(center, center);
            CONTEXT.arc(center, center, sliceRadius, start, end);
            CONTEXT.closePath();
            CONTEXT.fillStyle = colorForRestaurant(restaurant);
            CONTEXT.fill();
            CONTEXT.strokeStyle = "#fffaf2";
            CONTEXT.lineWidth = isHovered ? 4 : 3;
            CONTEXT.stroke();

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
            const fontSize = Math.max(10, Math.min(18, size / 24, 27 / Math.sqrt(Math.max(1, eligibleRestaurants.length / 7))));
            CONTEXT.font = `700 ${fontSize}px "Trebuchet MS", sans-serif`;
            const maxWidth = radius * 0.7;
            const name = displayRestaurantName(restaurant);
            const nameWidth = CONTEXT.measureText(name).width;
            const labelScale = Math.min(1.45, Math.max(1, maxWidth * 0.9 / nameWidth));
            const labelFontSize = fontSize * labelScale;
            CONTEXT.font = `700 ${labelFontSize}px "Trebuchet MS", sans-serif`;
            const scaledNameLines = wrapWheelLabel(name, maxWidth);
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

        CONTEXT.beginPath();
        CONTEXT.arc(center, center, Math.max(19, size * 0.055), 0, Math.PI * 2);
        CONTEXT.fillStyle = "#fffaf2";
        CONTEXT.fill();
        CONTEXT.lineWidth = 5;
        CONTEXT.strokeStyle = "#fff";
        CONTEXT.stroke();

    }

    function updateWheelHover(event) {
        if (spinning || eligibleRestaurants.length === 0) return;
        const bounds = WHEEL.getBoundingClientRect();
        const x = event.clientX - bounds.left - bounds.width / 2;
        const y = event.clientY - bounds.top - bounds.height / 2;
        const distance = Math.hypot(x, y);
        const radius = bounds.width / 2 - 17;
        let nextIndex = -1;

        if (distance >= 46 && distance <= radius + 13) {
            const angle = Math.atan2(y, x);
            const relativeAngle = ((angle + Math.PI / 2 - rotation) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
            nextIndex = Math.floor(relativeAngle / (Math.PI * 2) * eligibleRestaurants.length);
        }
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
            priceText(restaurant)
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
                DATA_NOTE.textContent = saveMessage;
            } catch (error) {
                message.textContent = error.message;
                message.classList.add("error");
            }
        });
        return form;
    }

    function renderRestaurants(now = getStockholmTime()) {
        hoveredRestaurantIndex = -1;
        WHEEL_TOOLTIP.hidden = true;
        assignRestaurantColors();
        const filtered = getFilteredRestaurants(now).sort((first, second) => compareByRelevance(first, second, now));
        const matchingPlaces = restaurants.filter((restaurant) => !hiddenIds.includes(restaurant.id)
            && matchesOtherFilters(restaurant, now));
        const matchingPlacesAreHidden = matchingPlaces.length === 0
            && restaurants.some((restaurant) => hiddenIds.includes(restaurant.id) && matchesOtherFilters(restaurant, now));
        const listEligible = filtered.filter((restaurant) => {
            const state = getStatus(restaurant, now).state;
            return state === "open"
                || state === "unknown"
                || (FILTERS.showClosed.checked && state === "closed");
        });
        // Keep the wheel's slices fixed mid-spin so it lands on the announced winner;
        // the finished spin re-renders with the latest filters.
        if (!spinning) eligibleRestaurants = listEligible;
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
        const openCount = filtered.filter((restaurant) => getStatus(restaurant, now).state === "open").length;
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

        filtered.forEach((restaurant) => {
            const status = getStatus(restaurant, now);
            const item = document.createElement("li");
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
            heading.append(statusDot);
            heading.prepend(name, categoryBadge);

            const actions = document.createElement("div");
            actions.className = "option-actions";
            const editButton = document.createElement("button");
            editButton.className = "edit-button";
            editButton.type = "button";
            editButton.textContent = "Edit";
            editButton.setAttribute("aria-label", `Edit ${displayRestaurantName(restaurant)}`);
            editButton.setAttribute("aria-expanded", "false");
            editButton.addEventListener("click", () => {
                const currentForm = details.querySelector(".edit-form");
                if (currentForm) {
                    currentForm.remove();
                    editButton.textContent = "Edit";
                    editButton.setAttribute("aria-expanded", "false");
                    return;
                }
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
                hiddenIds.push(restaurant.id);
                saveUserData();
                WINNER_DETAILS.replaceChildren();
                RESULT.textContent = "Restaurant removed from your list.";
                const undoButton = document.createElement("button");
                undoButton.className = "undo-button";
                undoButton.type = "button";
                undoButton.textContent = "Undo";
                undoButton.addEventListener("click", () => {
                    hiddenIds = hiddenIds.filter((id) => id !== restaurant.id);
                    saveUserData();
                    WINNER_DETAILS.replaceChildren();
                    renderRestaurants();
                    RESULT.textContent = `${displayRestaurantName(restaurant)} is back on your list.`;
                });
                WINNER_DETAILS.append(undoButton);
                renderRestaurants();
            });
            actions.append(editButton, removeButton);

            const details = document.createElement("div");
            details.className = "option-details";
            const statusLine = document.createElement("span");
            statusLine.className = `status-line ${status.state}`;
            statusLine.textContent = status.label;
            details.append(statusLine);

            const meta = document.createElement("span");
            const vegetarianText = restaurant.vegetarian === "yes"
                ? `Vegetarian: ${restaurant.vegetarianNote || "Yes"}`
                : restaurant.vegetarian === "no" ? "Vegetarian: No" : `Vegetarian: Not confirmed${restaurant.vegetarianNote ? ` — ${restaurant.vegetarianNote}` : ""}`;
            meta.textContent = `${vegetarianText} · ${priceText(restaurant)}`;
            details.append(meta);

            if (isWebLink(restaurant.vegetarianSource)) {
                details.append(createLink(restaurant.vegetarianSource, "Vegetarian source"));
            }

            if (restaurant.priceNote) {
                const priceNote = document.createElement("span");
                priceNote.textContent = `Published menu items: ${restaurant.priceNote}`;
                details.append(priceNote);
            }
            if (isWebLink(restaurant.priceSource)) {
                details.append(createLink(
                    restaurant.priceSource,
                    restaurant.priceCheckedAt
                        ? `Official menu price source · checked ${restaurant.priceCheckedAt}`
                        : "Price source"
                ));
            } else if (restaurant.priceSource === EDITED_IN_APP) {
                const priceSource = document.createElement("span");
                priceSource.textContent = "Price source: edited in this browser";
                details.append(priceSource);
            }
            if (restaurant.notice) {
                const notice = document.createElement("span");
                notice.className = "place-notice";
                notice.textContent = `Note: ${restaurant.notice}`;
                details.append(notice);
            }

            if (restaurant.hours) {
                const weeklyHours = document.createElement("span");
                weeklyHours.textContent = `Weekly hours: ${formatWeeklyHours(restaurant.hours)}`;
                details.append(weeklyHours);
            }
            if (restaurant.hoursSource) {
                const hoursSource = document.createElement("span");
                hoursSource.textContent = restaurant.hoursCheckedAt
                    ? `${restaurant.hoursSource} listing · checked ${restaurant.hoursCheckedAt}`
                    : `Hours source: ${restaurant.hoursSource}`;
                details.append(hoursSource);
            }

            if (restaurant.walkMinutes) {
                const walkLabel = `Walking time: ${restaurant.walkIsEstimate ? "~" : ""}${restaurant.walkMinutes} min`;
                details.append(createLink(directionsUrl(restaurant), walkLabel, "walk-link"));
            } else {
                const walk = document.createElement("span");
                walk.textContent = "Walking time: not added";
                details.append(walk);
            }

            if (restaurant.cuisine) {
                const cuisine = document.createElement("span");
                cuisine.textContent = `Cuisine: ${restaurant.cuisine.replace(/;/g, ", ")}`;
                details.append(cuisine);
            }
            if (restaurant.openingHoursText && !restaurant.hours) {
                const rawHours = document.createElement("span");
                rawHours.textContent = `Listed hours need checking: ${restaurant.openingHoursText}`;
                details.append(rawHours);
            }

            details.append(createLink(googleMapsUrl(restaurant), "Google Maps listing and hours"));
            item.append(heading, actions, details);
            OPTION_LIST.append(item);
        });

        if (spinning) {
            // The spin animation owns the result text until it finishes.
        } else if (listEligible.length === 0) {
            if (!WINNER_DETAILS.hasChildNodes()) {
                RESULT.textContent = !filtered.length
                    ? "Adjust filters or restore removed places above."
                    : FILTERS.showClosed.checked
                        ? "No matching places are eligible to spin."
                        : "No matching places are open now. Check “Include closed places on the wheel” to spin them anyway.";
            }
        } else if (!WINNER_DETAILS.hasChildNodes()) {
            RESULT.textContent = "Ready when you are!";
        }

        drawWheel();
    }

    function animateIdle(now) {
        const elapsed = lastIdleFrame === null ? 0 : Math.min(now - lastIdleFrame, 50);
        lastIdleFrame = now;
        if (!spinning && hoveredRestaurantIndex < 0 && !prefersReducedMotion.matches && eligibleRestaurants.length > 0) {
            rotation = (rotation + elapsed * (Math.PI * 2 / 60000)) % (Math.PI * 2);
            drawWheel();
        }

        requestAnimationFrame(animateIdle);
    }

    function resetFilters() {
        FILTERS.search.value = "";
        FILTERS.showClosed.checked = true;
        FILTERS.showUnpriced.checked = true;
        FILTERS.vegetarian.checked = false;
        FILTERS.walk.value = "";
        FILTERS.price.value = "";
        CATEGORY_FILTERS.forEach((input) => {
            input.checked = false;
        });
        updateCategoryFilterSummary();
        WINNER_DETAILS.replaceChildren();
        renderRestaurants();
    }

    function updateCategoryFilterSummary() {
        const selected = CATEGORY_FILTERS.filter((input) => input.checked)
            .map((input) => input.parentElement.textContent.trim());
        CATEGORY_FILTER_SUMMARY.textContent = selected.length === 0
            ? "All types"
            : selected.length <= 2 ? selected.join(" + ") : `${selected.length} types selected`;
    }

    function restoreHiddenPlaces(ids) {
        const restoredIds = new Set(ids);
        hiddenIds = hiddenIds.filter((id) => !restoredIds.has(id));
        saveUserData();
        WINNER_DETAILS.replaceChildren();
        renderRestaurants();
    }

    function spin() {
        if (spinning || eligibleRestaurants.length === 0) return;
        spinning = true;
        hoveredRestaurantIndex = -1;
        WHEEL_TOOLTIP.hidden = true;
        SPIN_BUTTON.disabled = true;
        RESULT.textContent = "Picking a lunch spot…";
        WINNER_DETAILS.replaceChildren();

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
            const info = document.createElement("strong");
            info.textContent = displayRestaurantName(selected);
            RESULT.replaceChildren("Today you’re having ", info, "!");
            WINNER_DETAILS.replaceChildren(`${getStatus(selected, getStockholmTime()).label} · ${priceText(selected)}`);
            if (selected.walkMinutes) {
                WINNER_DETAILS.append(createLink(
                    directionsUrl(selected),
                    `Walking time: ${selected.walkIsEstimate ? "~" : ""}${selected.walkMinutes} min`,
                    "walk-link"
                ));
            }
            WINNER_DETAILS.append(createLink(googleMapsUrl(selected), "Check Google Maps hours"));
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
            DATA_NOTE.textContent = "Restaurant data could not be loaded.";
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
        restaurants = applySavedRestaurantEdits([...data.restaurants, ...customRestaurants]);
        DATA_NOTE.textContent = `Starting point: ${data.location}. Checking nearby OpenStreetMap data; saved schedules use Stockholm local time.`;

        for (const input of [...Object.values(FILTERS), ...CATEGORY_FILTERS]) {
            input.addEventListener("change", () => {
                if (CATEGORY_FILTERS.includes(input)) updateCategoryFilterSummary();
                WINNER_DETAILS.replaceChildren();
                renderRestaurants();
            });
        }
        FILTERS.search.addEventListener("input", () => {
            WINNER_DETAILS.replaceChildren();
            renderRestaurants();
        });
        SPIN_BUTTON.addEventListener("click", spin);
        REFRESH_BUTTON.addEventListener("click", () => refreshNearbyData(true));
        WHEEL.addEventListener("pointermove", updateWheelHover);
        WHEEL.addEventListener("pointerleave", () => {
            hoveredRestaurantIndex = -1;
            WHEEL_TOOLTIP.hidden = true;
            drawWheel();
        });
        window.addEventListener("resize", drawWheel);

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
                RESULT.textContent = "Place added to your list.";
                WINNER_DETAILS.replaceChildren();
                renderRestaurants();
            } catch (error) {
                showFormMessage(error.message, true);
            }
        });

        renderRestaurants();
        requestAnimationFrame(animateIdle);
        refreshNearbyData();
        window.setInterval(() => {
            if (!spinning) renderRestaurants();
        }, 60_000);
    }

    initialize();
})();
