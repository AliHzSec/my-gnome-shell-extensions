/*
 * Name: SpeedMeter: Internet Speed Meter
 * Description: A simple and minimal internet speed meter extension for Gnome Shell.
 * Author: Ali Hamidi
 * GitHub: https://github.com/AliHz1337
 * License: GPLv3.0
 */

import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import NM from "gi://NM";
import Shell from "gi://Shell";
import St from "gi://St";

import {
    Extension
} from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

// Constants for speed calculation
const REFRESH_INTERVAL_SECONDS = 1.0;
const UNIT_BASE = 1024.0;
const BYTES_TO_MEGABYTES = UNIT_BASE * UNIT_BASE;

// Virtual network interfaces to ignore in speed calculation
const VIRTUAL_INTERFACE_PATTERN = /^(lo|br|tun|tap|vnet|virbr|docker|veth)\d*$/;

/**
 * SpeedMeterButton - Main panel button widget for the extension
 * Displays network speed and provides detailed network information in a popup menu
 */
const SpeedMeterButton = GObject.registerClass(
    class SpeedMeterButton extends PanelMenu.Button {
        _init(extension) {
            super._init(0.5, 'SpeedMeter');

            this._extension = extension;
            this._client = null;
            this._refreshLoop = null;
            this._prevUploadBytes = 0;
            this._prevDownloadBytes = 0;

            // Create speed label for panel
            this._speedLabel = new St.Label({
                text: '↓ 0.00 MB/s  ↑ 0.00 MB/s',
                style_class: 'speedmeter-speed-label',
                y_align: Clutter.ActorAlign.CENTER
            });
            this.add_child(this._speedLabel);

            // Build popup menu content
            this._createMenu();

            // Connect to NetworkManager asynchronously
            NM.Client.new_async(null, this._onNetworkManagerReady.bind(this));

            // Start speed monitoring
            this._startSpeedUpdate();
        }

        /**
         * Creates the popup menu structure
         */
        _createMenu() {
            const menuSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(menuSection);

            const networkBox = new St.BoxLayout({
                style_class: 'speedmeter-network-info-box',
                vertical: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            menuSection.actor.add_child(networkBox);

            // Menu title
            const titleLabel = new St.Label({
                text: 'Network Information',
                style_class: 'speedmeter-network-info-title'
            });
            networkBox.add_child(titleLabel);

            // Container for network information rows
            this._infoBox = new St.BoxLayout({
                vertical: true,
            });
            networkBox.add_child(this._infoBox);

            // Action buttons container
            const buttonBox = new St.BoxLayout({
                style_class: 'speedmeter-button-box',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.FILL,
            });
            menuSection.actor.add_child(buttonBox);

            // Refresh button
            const refreshButton = new St.Button({
                style_class: 'speedmeter-icon-button',
                reactive: true,
                can_focus: true,
                track_hover: true,
                x_expand: false,
                x_align: Clutter.ActorAlign.END,
            });
            const refreshIcon = new St.Icon({
                icon_name: 'view-refresh-symbolic',
                style_class: 'popup-menu-icon',
            });
            refreshButton.set_child(refreshIcon);
            refreshButton.connect('clicked', () => this._updateNetworkInfo());
            buttonBox.add_child(refreshButton);
        }

        /**
         * Callback when NetworkManager client is ready
         * @param {Object} obj - Source object
         * @param {Object} result - Async result
         */
        _onNetworkManagerReady(obj, result) {
            try {
                this._client = NM.Client.new_finish(result);

                // Connect to NetworkManager signals for connection changes
                this._client.connectObject(
                    'notify::primary-connection', () => this._updateNetworkInfo(),
                    'notify::active-connections', () => this._updateNetworkInfo(),
                    this
                );

                this._updateNetworkInfo();
            } catch (e) {
                console.error('SpeedMeter: Error connecting to NetworkManager:', e);
                this._displayError('NetworkManager connection failed');
            }
        }

        /**
         * Updates network information in the popup menu
         */
        _updateNetworkInfo() {
            // Clear existing content
            this._infoBox.destroy_all_children();

            if (!this._client) {
                this._addInfoRow('Status', 'NetworkManager not available');
                return;
            }

            const activeConnections = this._client.get_active_connections();
            const primaryConnection = this._client.get_primary_connection();

            if (!primaryConnection) {
                this._addInfoRow('Status', 'No active connection');
                return;
            }

            // Add separator
            this._addSeparator();

            // Display primary connection info
            this._displayConnectionInfo(primaryConnection, 'Primary Connection');

            // Check for VPN connections
            const vpnConnections = activeConnections.filter(conn => {
                const connType = conn.get_connection_type();
                return conn.get_vpn() || ['vpn', 'wireguard', 'tun'].includes(connType);
            });

            // Add separator before VPN section
            this._addSeparator();

            if (vpnConnections.length > 0) {
                // Display VPN connection info
                this._displayConnectionInfo(vpnConnections[0], 'VPN Connection');
            } else {
                // Display VPN inactive status
                this._displayVPNInactive();
            }

            // Add final separator
            this._addSeparator();
        }

        /**
         * Displays information for a network connection
         * @param {NM.ActiveConnection} connection - Network connection
         * @param {string} sectionTitle - Title for this section
         */
        _displayConnectionInfo(connection, sectionTitle) {
            // Section title
            const sectionLabel = new St.Label({
                text: sectionTitle,
                style_class: 'speedmeter-network-section-title'
            });
            this._infoBox.add_child(sectionLabel);

            // Connection name
            this._addInfoRow('Connection', connection.get_id());

            // Connection type (only for VPN)
            const connType = connection.get_connection_type();
            const isVPN = ['vpn', 'wireguard', 'tun'].includes(connType);
            if (isVPN) {
                this._addInfoRow('Type', connType);
            }

            // Connection state
            const state = connection.get_state();
            const stateText = this._getConnectionStateText(state);
            this._addInfoRow('State', stateText);

            // Device information
            const devices = connection.get_devices();
            if (devices && devices.length > 0) {
                const device = devices[0];
                this._displayDeviceInfo(device, connType, isVPN);
            }
        }

        /**
         * Displays device-specific information
         * @param {NM.Device} device - Network device
         * @param {string} connType - Connection type
         * @param {boolean} isVPN - Whether this is a VPN connection
         */
        _displayDeviceInfo(device, connType, isVPN) {
            const iface = device.get_iface();
            this._addInfoRow('Interface', iface);

            // IPv4 Configuration
            const ip4Config = device.get_ip4_config();
            if (ip4Config) {
                this._displayIPv4Info(ip4Config, device, connType, iface, isVPN);
            }

            // MAC Address (for physical interfaces)
            const hwAddress = device.get_hw_address();
            if (hwAddress && hwAddress !== '00:00:00:00:00:00') {
                this._addInfoRow('MAC Address', hwAddress);
            }

            // WiFi-specific information
            if (device instanceof NM.DeviceWifi) {
                this._displayWiFiInfo(device);
            }
        }

        /**
         * Displays IPv4 configuration information
         * @param {NM.IP4Config} ip4Config - IPv4 configuration
         * @param {NM.Device} device - Network device
         * @param {string} connType - Connection type
         * @param {string} iface - Interface name
         * @param {boolean} isVPN - Whether this is a VPN connection
         */
        _displayIPv4Info(ip4Config, device, connType, iface, isVPN) {
            // IP addresses
            const addresses = ip4Config.get_addresses();
            if (addresses && addresses.length > 0) {
                this._addInfoRow('IPv4', addresses[0].get_address());
                this._addInfoRow('Netmask', this._cidrToNetmask(addresses[0].get_prefix()));
            }

            // Gateway
            const gateway = ip4Config.get_gateway();
            if (gateway) {
                this._addInfoRow('Gateway', gateway);
            } else if (connType === 'wireguard' || iface.startsWith('wg')) {
                // Try to read gateway from routing table for WireGuard
                const wgInfo = this._getWireGuardInfo(iface);
                if (wgInfo.gateway) {
                    this._addInfoRow('Gateway', wgInfo.gateway);
                }
            }

            // DNS Servers
            const nameservers = ip4Config.get_nameservers();
            if (nameservers && nameservers.length > 0) {
                this._addInfoRow('DNS', nameservers.join(', '));
            } else if (isVPN) {
                // Try to read DNS from connection settings
                this._displayVPNDNS(device);
            }
        }

        /**
         * Attempts to display DNS settings for VPN connections
         * @param {NM.Device} device - Network device
         */
        _displayVPNDNS(device) {
            try {
                const conn = device.get_active_connection()?.get_connection();
                if (conn) {
                    const ip4Setting = conn.get_setting_ip4_config();
                    if (ip4Setting) {
                        const dnsCount = ip4Setting.get_num_dns();
                        if (dnsCount > 0) {
                            const dnsServers = [];
                            for (let i = 0; i < dnsCount; i++) {
                                dnsServers.push(ip4Setting.get_dns(i));
                            }
                            this._addInfoRow('DNS', dnsServers.join(', '));
                        }
                    }
                }
            } catch (e) {
                console.log('SpeedMeter: Could not read DNS from connection settings:', e);
            }
        }

        /**
         * Displays WiFi-specific information
         * @param {NM.DeviceWifi} device - WiFi device
         */
        _displayWiFiInfo(device) {
            const activeAP = device.get_active_access_point();
            if (!activeAP) return;

            const strength = activeAP.get_strength();
            this._addInfoRow('Signal Strength', `${strength}%`);

            const ssidBytes = activeAP.get_ssid();
            if (ssidBytes) {
                try {
                    const ssid = new TextDecoder().decode(ssidBytes.get_data());
                    this._addInfoRow('SSID', ssid);
                } catch (e) {
                    console.log('SpeedMeter: Could not decode SSID:', e);
                }
            }
        }

        /**
         * Retrieves WireGuard-specific routing information
         * @param {string} iface - Interface name
         * @returns {Object} Object containing gateway information
         */
        _getWireGuardInfo(iface) {
            try {
                const [ok, routeOutput] = GLib.spawn_command_line_sync(`ip route show dev ${iface}`);
                if (ok && routeOutput) {
                    const routeText = new TextDecoder().decode(routeOutput);
                    const lines = routeText.split('\n');

                    for (const line of lines) {
                        // Find default route
                        if (line.includes('default') || line.includes('0.0.0.0/0')) {
                            const parts = line.split(/\s+/);
                            const viaIndex = parts.indexOf('via');
                            if (viaIndex > -1 && viaIndex < parts.length - 1) {
                                return { gateway: parts[viaIndex + 1] };
                            }
                        }
                    }
                }
            } catch (e) {
                console.log('SpeedMeter: Could not read WireGuard routing info:', e);
            }
            return {};
        }

        /**
         * Displays VPN inactive status
         */
        _displayVPNInactive() {
            const vpnStatusRow = new St.BoxLayout();
            this._infoBox.add_child(vpnStatusRow);

            const vpnLabel = new St.Label({
                style_class: 'speedmeter-network-info-key speedmeter-vpn-inactive',
                text: 'VPN Status: ',
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: true,
            });
            vpnStatusRow.add_child(vpnLabel);

            const vpnStatus = new St.Label({
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_expand: true,
                style_class: 'speedmeter-network-info-value speedmeter-vpn-inactive',
                text: 'Inactive',
            });
            vpnStatusRow.add_child(vpnStatus);
        }

        /**
         * Adds a separator to the info box
         */
        _addSeparator() {
            const separator = new PopupMenu.PopupSeparatorMenuItem();
            this._infoBox.add_child(separator);
        }

        /**
         * Adds an information row with label and value (value is clickable to copy)
         * @param {string} label - Label text
         * @param {string} value - Value text
         */
        _addInfoRow(label, value) {
            const row = new St.BoxLayout();
            this._infoBox.add_child(row);

            const labelWidget = new St.Label({
                style_class: 'speedmeter-network-info-key',
                text: `${label}: `,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: true,
            });
            row.add_child(labelWidget);

            const valueLabel = new St.Label({
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_expand: true,
                style_class: 'speedmeter-network-info-value',
                text: value || 'N/A',
            });

            // Make value clickable to copy to clipboard
            const valueButton = new St.Button({
                child: valueLabel,
            });
            valueButton.connect('button-press-event', () => {
                const clipboard = St.Clipboard.get_default();
                clipboard.set_text(St.ClipboardType.CLIPBOARD, valueButton.child.text);
            });
            row.add_child(valueButton);
        }

        /**
         * Displays an error message in the info box
         * @param {string} message - Error message
         */
        _displayError(message) {
            this._infoBox.destroy_all_children();
            this._addInfoRow('Error', message);
        }

        /**
         * Converts connection state enum to human-readable text
         * @param {NM.ActiveConnectionState} state - Connection state
         * @returns {string} State description
         */
        _getConnectionStateText(state) {
            switch (state) {
                case NM.ActiveConnectionState.ACTIVATED:
                    return 'Connected';
                case NM.ActiveConnectionState.ACTIVATING:
                    return 'Connecting...';
                case NM.ActiveConnectionState.DEACTIVATING:
                    return 'Disconnecting...';
                case NM.ActiveConnectionState.DEACTIVATED:
                    return 'Disconnected';
                default:
                    return 'Unknown';
            }
        }

        /**
         * Converts CIDR prefix to netmask notation
         * @param {number} prefix - CIDR prefix length
         * @returns {string} Netmask in dotted decimal notation
         */
        _cidrToNetmask(prefix) {
            const mask = ~(0xffffffff >>> prefix) >>> 0;
            return [
                (mask >>> 24) & 0xff,
                (mask >>> 16) & 0xff,
                (mask >>> 8) & 0xff,
                mask & 0xff
            ].join('.');
        }

        /**
         * Starts the speed update loop
         */
        _startSpeedUpdate() {
            // Initialize baseline values
            this._updateSpeed(true);

            // Start periodic updates
            this._refreshLoop = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                REFRESH_INTERVAL_SECONDS,
                () => {
                    this._updateSpeed(false);
                    return GLib.SOURCE_CONTINUE;
                }
            );
        }

        /**
         * Updates network speed display
         * @param {boolean} initialize - If true, only reads baseline values without updating display
         */
        _updateSpeed(initialize = false) {
            try {
                const lines = Shell.get_file_contents_utf8_sync('/proc/net/dev').split('\n');
                let uploadBytes = 0;
                let downloadBytes = 0;

                // Sum bytes from all relevant network interfaces
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    const columns = trimmedLine.split(/\s+/);

                    if (columns.length <= 2) continue;

                    const iface = columns[0].replace(':', '');

                    // Skip virtual and loopback interfaces
                    if (VIRTUAL_INTERFACE_PATTERN.test(iface)) {
                        continue;
                    }

                    const rxBytes = parseInt(columns[1]);
                    const txBytes = parseInt(columns[9]);

                    if (!isNaN(rxBytes) && !isNaN(txBytes)) {
                        downloadBytes += rxBytes;
                        uploadBytes += txBytes;
                    }
                }

                if (initialize) {
                    // Store baseline values
                    this._prevDownloadBytes = downloadBytes;
                    this._prevUploadBytes = uploadBytes;
                    return;
                }

                // Calculate speed in bytes per second
                const downloadSpeed = (downloadBytes - this._prevDownloadBytes) / REFRESH_INTERVAL_SECONDS;
                const uploadSpeed = (uploadBytes - this._prevUploadBytes) / REFRESH_INTERVAL_SECONDS;

                // Update baseline values for next iteration
                this._prevDownloadBytes = downloadBytes;
                this._prevUploadBytes = uploadBytes;

                // Convert to MB/s and update display
                const downMBps = downloadSpeed / BYTES_TO_MEGABYTES;
                const upMBps = uploadSpeed / BYTES_TO_MEGABYTES;

                this._speedLabel.set_text(
                    `↓ ${downMBps.toFixed(2)} MB/s  ↑ ${upMBps.toFixed(2)} MB/s`
                );

            } catch (e) {
                console.error('SpeedMeter: Error updating speed:', e);
                this._speedLabel.set_text('↓ -.-- MB/s  ↑ -.-- MB/s');
            }
        }

        /**
         * Cleanup when extension is disabled
         */
        disable() {
            // Remove speed update timer
            if (this._refreshLoop) {
                GLib.source_remove(this._refreshLoop);
                this._refreshLoop = null;
            }

            // Disconnect from NetworkManager
            if (this._client) {
                this._client.disconnectObject(this);
                this._client = null;
            }

            // Reset state
            this._prevDownloadBytes = 0;
            this._prevUploadBytes = 0;
        }
    });

/**
 * SpeedMeterExtension - Main extension class
 */
export default class SpeedMeterExtension extends Extension {
    enable() {
        this._indicator = new SpeedMeterButton(this);
        Main.panel.addToStatusArea('speed-meter', this._indicator, 0, 'right');
    }

    disable() {
        if (this._indicator) {
            this._indicator.disable();
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
