import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

// API configuration with fallback order
const API_ENDPOINTS = [
    {
        name: 'ip-api.com',
        url: 'http://ip-api.com/json',
        fieldMap: {
            ip: 'query',
            country: 'country',
            countryCode: 'countryCode',
            city: 'city',
            region: 'regionName',
            isp: 'isp',
            timezone: 'timezone',
        },
    },
    {
        name: 'api.my-ip.io',
        url: 'https://api.my-ip.io/v2/ip.json',
        fieldMap: {
            ip: 'ip',
            country: 'country.name',
            countryCode: 'country.code',
            city: null,
            region: null,
            isp: 'asn.name',
            timezone: 'timeZone',
        },
    },
    {
        name: 'ifconfig.co',
        url: 'https://ifconfig.co/json',
        fieldMap: {
            ip: 'ip',
            country: 'country',
            countryCode: 'country_iso',
            city: null,
            region: null,
            isp: 'asn_org',
            timezone: 'time_zone',
        },
    },
];

/**
 * Get nested property value from object using dot notation
 * @param {object} obj - The object to search
 * @param {string} path - The path in dot notation (e.g., 'country.name')
 * @returns {any} The value or undefined
 */
function getNestedValue(obj, path) {
    if (!path) return undefined;
    return path.split('.').reduce((current, prop) => current?.[prop], obj);
}

/**
 * Normalize API response to standard format
 * @param {object} rawData - Raw API response
 * @param {object} fieldMap - Field mapping configuration
 * @returns {object} Normalized data object
 */
function normalizeApiResponse(rawData, fieldMap) {
    const normalized = {};

    for (const [standardKey, apiKey] of Object.entries(fieldMap)) {
        if (apiKey === null) {
            normalized[standardKey] = null;
        } else {
            const value = getNestedValue(rawData, apiKey);
            normalized[standardKey] = value !== undefined ? value : null;
        }
    }

    return normalized;
}

/**
 * Fetch IP details with fallback to multiple API sources
 * @param {Soup.Session} session
 * @param {string} extensionPath - Path to extension directory for loading countries.json
 * @returns {{data: object | null, error: string | null, apiUsed: string | null}} object containing the data of the IP details or error message on fail
 */
export async function getIPDetails(session, extensionPath) {
    const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    let lastError = null;

    // Try each API in sequence
    for (const api of API_ENDPOINTS) {
        try {
            console.log(`IP-Finder: Trying ${api.name}...`);

            const message = Soup.Message.new('GET', api.url);
            message.request_headers.append('User-Agent', USER_AGENT);

            const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);

            // Check HTTP status code
            if (message.status_code !== 200) {
                console.log(`IP-Finder: ${api.name} returned status code ${message.status_code}, trying next API...`);
                lastError = `${api.name} returned status ${message.status_code}`;
                continue;
            }

            // Parse response
            const decoder = new TextDecoder('utf-8');
            const rawData = JSON.parse(decoder.decode(bytes.get_data()));

            // Normalize the response
            const normalizedData = normalizeApiResponse(rawData, api.fieldMap);

            console.log(`IP-Finder: Successfully fetched data from ${api.name}`);
            return {data: normalizedData, apiUsed: api.name};

        } catch (e) {
            console.log(`IP-Finder: Error with ${api.name}: ${e}`);
            lastError = `${api.name}: ${e.message || e}`;
            continue;
        }
    }

    // All APIs failed
    console.log('IP-Finder: All API sources exhausted');
    return {error: lastError || 'All API sources failed'};
}

/**
 *
 * @param {Array} coordinates
 * @param {int} zoom
 */
export function getMapTileInfo(coordinates, zoom) {
    const [lat, lon] = coordinates.split(', ').map(Number);
    const xTile = Math.floor((lon + 180.0) / 360.0 * (1 << zoom));
    const yTile = Math.floor((1.0 - Math.log(Math.tan(lat * Math.PI / 180.0) + 1.0 / Math.cos(lat * Math.PI / 180.0)) / Math.PI) / 2.0 * (1 << zoom));

    return {zoom, xTile, yTile};
}

/**
 *
 * @param {Soup.Session} session
 * @param {object} soupParams
 * @param {string} extensionPath
 * @param {string} tileInfo
 * @returns {{file: Gio.File | null, error: string | null}} object containing the map tile file or error message on fail
 */
export async function getMapTile(session, soupParams, extensionPath, tileInfo) {
    const file = Gio.file_new_for_path(`${extensionPath}/icons/latest_map.png`);

    const message = Soup.Message.new_from_encoded_form(
        'GET',
        `https://a.tile.openstreetmap.org/${tileInfo}.png`,
        Soup.form_encode_hash(soupParams)
    );

    let data;
    try {
        const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);

        if (message.statusCode === Soup.Status.OK) {
            data = bytes.get_data();
            const [success, etag_] = await file.replace_contents_bytes_async(data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            return success ? {file} : {error: 'Error replacing map tile file.'};
        } else {
            console.log(`IP-Finder getMapTile() failed with status code - ${message.statusCode}`);
            return {error: message.statusCode};
        }
    } catch (e) {
        console.log(`IP-Finder getMapTile() error - ${e}`);
        return {error: message.statusCode};
    }
}
