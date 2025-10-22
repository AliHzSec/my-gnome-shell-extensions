/* eslint-disable jsdoc/require-jsdoc */
/*
 * IP-Finder GNOME Extension by ArcMenu Team
 * https://gitlab.com/arcmenu-team/IP-Finder
 *
 * ArcMenu Team
 * Andrew Zaech https://gitlab.com/AndrewZaech
 * LinxGem33 (Andy C) https://gitlab.com/LinxGem33
 *
 * Find more from ArcMenu Team at
 * https://gitlab.com/arcmenu-team
 * https://github.com/ArcMenu
 *
 * Credits: _syncMainConnection(), _mainConnectionStateChanged()
 *  _flushConnectivityQueue(), _closeConnectivityCheck(), _portalHelperDone(), _syncConnectivity()
 * borrowed from GNOME shell.
 *
 * This file is part of IP Finder gnome extension.
 * IP Finder gnome extension is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * IP Finder gnome extension is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with IP Finder gnome extension.  If not, see <http://www.gnu.org/licenses/>.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import NM from 'gi://NM';
import Soup from 'gi://Soup';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import { loadInterfaceXML } from 'resource:///org/gnome/shell/misc/fileUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Utils from './utils.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const PortalHelperIface = loadInterfaceXML('org.gnome.Shell.PortalHelper');
const PortalHelperInfo = Gio.DBusInterfaceInfo.new_for_xml(PortalHelperIface);

const PortalHelperResult = {
    CANCELLED: 0,
    COMPLETED: 1,
    RECHECK: 2,
};

const DEBUG_LOG = false;
function debugLog(msg) {
    if (!DEBUG_LOG)
        return;

    console.log(msg);
}

/**
 * Load flag emojis from countries.json
 * @param {string} extensionPath - Path to extension directory
 * @returns {object} Country code to flag emoji mapping
 */
function loadCountryFlags(extensionPath) {
    try {
        const file = Gio.File.new_for_path(`${extensionPath}/countries.json`);
        const [success, contents] = file.load_contents(null);
        if (success) {
            const decoder = new TextDecoder('utf-8');
            return JSON.parse(decoder.decode(contents));
        }
    } catch (e) {
        console.error(`IP-Finder: Error loading countries.json: ${e}`);
    }
    return {};
}

/**
 * Get flag emoji for a country code
 * @param {string} countryCode - Two-letter country code
 * @param {object} flagMap - Country code to flag emoji mapping
 * @returns {string} Flag emoji or empty string
 */
function getFlagEmoji(countryCode, flagMap) {
    if (!countryCode || !flagMap) return '';
    return flagMap[countryCode.toUpperCase()] || '';
}

var VpnInfoBox = GObject.registerClass(
    class IPFinderVpnInfoBox extends St.BoxLayout {
        _init(params) {
            super._init({
                ...params,
            });

            // Icon comes first (on the left)
            this._vpnIcon = new St.Icon({
                style_class: 'popup-menu-icon ip-info-vpn-off',
            });
            this.add_child(this._vpnIcon);

            // Then the VPN label
            this._vpnTitleLabel = new St.Label({
                style_class: 'ip-info-vpn-off',
                text: 'VPN: ',
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.START,
                y_expand: false,
            });
            this.add_child(this._vpnTitleLabel);

            // Then the status label
            this._vpnStatusLabel = new St.Label({
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.START,
                x_expand: true,
                y_expand: false,
                style_class: 'ip-info-vpn-off',
            });
            this.add_child(this._vpnStatusLabel);
        }

        setVpnStatus(vpnStatus) {
            this._vpnTitleLabel.set_style_class_name(vpnStatus.styleClass);
            this._vpnStatusLabel.set_style_class_name(vpnStatus.styleClass);
            this._vpnIcon.set_style_class_name(`popup-menu-icon ${vpnStatus.styleClass}`);

            this._vpnStatusLabel.text = vpnStatus.vpnOn ? vpnStatus.vpnName : 'Off';
            this._vpnIcon.gicon = Gio.icon_new_for_string(vpnStatus.iconPath);
        }
    });

var BaseButton = GObject.registerClass(
    class IPFinderBaseButton extends St.Button {
        _init(text, params) {
            super._init({
                style_class: 'icon-button',
                reactive: true,
                can_focus: true,
                track_hover: true,
                button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
                ...params,
            });

            this.connect('notify::hover', () => this._onHover());
            this.connect('destroy', () => this._onDestroy());

            this.tooltipLabel = new St.Label({
                style_class: 'dash-label tooltip-label',
                text: text,
            });
            this.tooltipLabel.hide();
            global.stage.add_child(this.tooltipLabel);
        }

        _onHover() {
            if (this.hover)
                this.showLabel();
            else
                this.hideLabel();
        }

        showLabel() {
            this.tooltipLabel.opacity = 0;
            this.tooltipLabel.show();

            const [stageX, stageY] = this.get_transformed_position();

            const itemWidth = this.allocation.get_width();
            const itemHeight = this.allocation.get_height();

            const labelWidth = this.tooltipLabel.get_width();
            const labelHeight = this.tooltipLabel.get_height();
            const offset = 6;
            const xOffset = Math.floor((itemWidth - labelWidth) / 2);

            const monitorIndex = Main.layoutManager.findIndexForActor(this);
            const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);

            let y;
            const x = Math.clamp(stageX + xOffset, 0 + offset, workArea.x + workArea.width - labelWidth - offset);

            // Check if should place tool-tip above or below app icon
            // Needed in case user has moved the panel to bottom of screen
            const labelBelowIconRect = new Mtk.Rectangle({
                x,
                y: stageY + itemHeight + offset,
                width: labelWidth,
                height: labelHeight,
            });

            if (workArea.contains_rect(labelBelowIconRect))
                y = labelBelowIconRect.y;
            else
                y = stageY - labelHeight - offset;

            this.tooltipLabel.remove_all_transitions();
            this.tooltipLabel.set_position(x, y);
            this.tooltipLabel.ease({
                opacity: 255,
                duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        hideLabel() {
            this.tooltipLabel.ease({
                opacity: 0,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this.tooltipLabel.hide(),
            });
        }

        _onDestroy() {
            this.tooltipLabel.remove_all_transitions();
            this.tooltipLabel.hide();
            global.stage.remove_child(this.tooltipLabel);
            this.tooltipLabel.destroy();
        }
    });

var IPFinderMenuButton = GObject.registerClass(
    class IPFinderMenuButton extends PanelMenu.Button {
        _init(extension) {
            super._init(0.5, 'IP Details');
            this.menu.box.add_style_class_name('ip-finder-menu-box');

            this._defaultIpData = {
                ip: { name: 'IP Address', text: 'Loading IP Details' },
                country: { name: 'Country Name', text: '' },
                countryCode: { name: 'Country Code', text: '' },
                city: { name: 'City', text: '' },
                region: { name: 'Region', text: '' },
                isp: { name: 'ISP', text: '' },
                timezone: { name: 'Timezone', text: '' },
            };

            this._extension = extension;

            // Load country flag mappings
            this._countryFlags = loadCountryFlags(this._extension.path);

            const SESSION_TYPE = GLib.getenv('XDG_SESSION_TYPE');
            const PACKAGE_VERSION = Config.PACKAGE_VERSION;
            const USER_AGENT = `User-Agent: Mozilla/5.0 (${SESSION_TYPE}; GNOME Shell/${PACKAGE_VERSION}; Linux ${GLib.getenv('CPU')};) IP_Finder/${this._extension.metadata.version}`;
            this._session = new Soup.Session({ user_agent: USER_AGENT, timeout: 60 });

            const panelBox = new St.BoxLayout({
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.FILL,
                style_class: 'panel-status-menu-box ip-finder-panel-box',
            });
            this.add_child(panelBox);

            this._vpnStatusIcon = new St.Icon({
                icon_name: 'changes-prevent-symbolic',
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'system-status-icon',
            });
            panelBox.add_child(this._vpnStatusIcon);

            this._ipAddress = this._defaultIpData.ip.text;
            this._ipAddressLabel = new St.Label({
                text: this._ipAddress,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'system-status-icon',
            });
            panelBox.add_child(this._ipAddressLabel);

            this._statusIcon = new St.Icon({
                icon_name: 'network-wired-acquiring-symbolic',
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'system-status-icon',
            });
            panelBox.add_child(this._statusIcon);

            this._flagIcon = new St.Label({
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'system-status-icon',
                visible: false,
            });
            panelBox.add_child(this._flagIcon);

            const menuSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(menuSection);

            const ipInfoParentBox = new St.BoxLayout({
                style_class: 'ip-info-box ip-info-parent-box',
                vertical: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            menuSection.actor.add_child(ipInfoParentBox);

            this._vpnInfoBox = new VpnInfoBox();
            ipInfoParentBox.add_child(this._vpnInfoBox);

            this._ipInfoBox = new St.BoxLayout({
                vertical: true,
            });
            ipInfoParentBox.add_child(this._ipInfoBox);

            // const buttonBox = new St.BoxLayout({
            //     style_class: 'ip-finder-button-box',
            // });
            // menuSection.actor.add_child(buttonBox);
            const buttonBox = new St.BoxLayout({
                style_class: 'ip-finder-button-box',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.FILL,
            });
            menuSection.actor.add_child(buttonBox);

            // Copy button (left side)
            // const copyButton = new BaseButton('Copy IP', {
            //     icon_name: 'edit-copy-symbolic',
            //     x_expand: true,
            //     x_align: Clutter.ActorAlign.CENTER,
            // });
            // copyButton.connect('clicked', () => this._setClipboardText(this._ipAddress));
            // buttonBox.add_child(copyButton);
            const copyButton = new BaseButton('Copy IP', {
                icon_name: 'edit-copy-symbolic',
                x_expand: false,
                x_align: Clutter.ActorAlign.START,
            });
            copyButton.connect('clicked', () => this._setClipboardText(this._ipAddress));
            buttonBox.add_child(copyButton);

            const spacer = new St.BoxLayout({
                x_expand: true,
            });
            buttonBox.add_child(spacer);

            // Refresh button (right side)
            // const refreshButton = new BaseButton('Refresh', {
            //     icon_name: 'view-refresh-symbolic',
            //     x_expand: false,
            //     x_align: Clutter.ActorAlign.END,
            // });
            // refreshButton.connect('clicked', () => this._startGetIpInfo());
            // buttonBox.add_child(refreshButton);
            const refreshButton = new BaseButton('Refresh', {
                icon_name: 'view-refresh-symbolic',
                x_expand: false,
                x_align: Clutter.ActorAlign.END,
            });
            refreshButton.connect('clicked', () => this._startGetIpInfo());
            buttonBox.add_child(refreshButton);

            NM.Client.new_async(null, this.establishNetworkConnectivity.bind(this));

            // Hard-coded: Always position on the RIGHT side of panel
            Main.panel.addToStatusArea('ip-menu', this, 1, 'right');
            this._updatePanelWidgets();
            this._updateVPNWidgets();
        }

        _setClipboardText(text) {
            const clipboard = St.Clipboard.get_default();
            clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        }

        _updatePanelWidgets() {
            // Hard-coded: Always show both Flag and IP Address
            this._flagIcon.show();
            this._ipAddressLabel.show();

            this._setPanelWidgetsPadding();
        }

        _updateVPNWidgets() {
            // Hard-coded: VPN status always enabled and showing
            const showVpnStatus = true;

            // The vpn 'lock' icon in the panelmenu.button
            this._vpnStatusIcon.visible = showVpnStatus;
            // The vpn info box in the panelmenu.button popupmenu
            this._vpnInfoBox.visible = showVpnStatus;

            this._vpnStatusIcon.icon_name = this._vpnConnectionOn ? 'changes-prevent-symbolic' : 'changes-allow-symbolic';

            // Hard-coded: VPN icon color always enabled
            this._vpnStatusIcon.style_class = this._vpnConnectionOn ? 'system-status-icon ip-info-vpn-on' : 'system-status-icon ip-info-vpn-off';

            // Hard-coded: IP address color always WHITE (system default)
            this._ipAddressLabel.style_class = 'system-status-icon';

            this._setPanelWidgetsPadding();
        }

        _setPanelWidgetsPadding() {
            // Padding is now handled by CSS - no inline styles needed
        }

        establishNetworkConnectivity(obj, result) {
            this._client = NM.Client.new_finish(result);

            this._connectivityQueue = new Set();

            this._mainConnection = null;

            this._client.connectObject(
                'notify::primary-connection', () => this._syncMainConnection(),
                'notify::activating-connection', () => this._syncMainConnection(),
                'notify::active-connections', () => this._syncMainConnection(),
                'notify::connectivity', () => this._syncConnectivity(),
                this);
            this._syncMainConnection();
        }

        _syncMainConnection() {
            this._setAcquiringDetials();
            this._mainConnection?.disconnectObject(this);

            this._mainConnection =
                this._client.get_primary_connection() ||
                this._client.get_activating_connection();

            if (this._mainConnection) {
                this._mainConnection.connectObject('notify::state',
                    this._mainConnectionStateChanged.bind(this), this);
                this._mainConnectionStateChanged();
            }

            this._syncConnectivity();
        }

        _mainConnectionStateChanged() {
            if (this._mainConnection.state === NM.ActiveConnectionState.ACTIVATED)
                this._startGetIpInfo();
        }

        _startGetIpInfo() {
            this._session.abort();
            this._removeGetIpInfoId();
            this._setAcquiringDetials();

            this._getIpInfoId = GLib.timeout_add(0, 2000, () => {
                this._getIpInfo().catch(err => console.log(err));
                this._getIpInfoId = null;
                return GLib.SOURCE_REMOVE;
            });
        }

        _removeGetIpInfoId() {
            if (this._getIpInfoId) {
                GLib.source_remove(this._getIpInfoId);
                this._getIpInfoId = null;
            }
        }

        _flushConnectivityQueue() {
            for (const item of this._connectivityQueue)
                this._portalHelperProxy?.CloseAsync(item);
            this._connectivityQueue.clear();
        }

        _closeConnectivityCheck(path) {
            if (this._connectivityQueue.delete(path))
                this._portalHelperProxy?.CloseAsync(path);
        }

        async _portalHelperDone(proxy, emitter, parameters) {
            const [path, result] = parameters;

            if (result === PortalHelperResult.CANCELLED) {
                this._setIpDetails();
                // Keep the connection in the queue, so the user is not
                // spammed with more logins until we next flush the queue,
                // which will happen once they choose a better connection
                // or we get to full connectivity through other means
            } else if (result === PortalHelperResult.COMPLETED) {
                this._startGetIpInfo();
                this._closeConnectivityCheck(path);
            } else if (result === PortalHelperResult.RECHECK) {
                this._setIpDetails();
                try {
                    const state = await this._client.check_connectivity_async(null);
                    if (state >= NM.ConnectivityState.FULL) {
                        this._startGetIpInfo();
                        this._closeConnectivityCheck(path);
                    }
                } catch (e) { }
            } else {
                this._setIpDetails(null, `Invalid result from portal helper: ${result}`);
            }
        }

        async _syncConnectivity() {
            if (this._client.get_active_connections().length < 1 || this._client.connectivity === NM.ConnectivityState.NONE)
                this._setIpDetails();

            if (this._mainConnection == null ||
                this._mainConnection.state !== NM.ActiveConnectionState.ACTIVATED) {
                this._setIpDetails();
                this._flushConnectivityQueue();
                return;
            }

            let isPortal = this._client.connectivity === NM.ConnectivityState.PORTAL;
            // For testing, allow interpreting any value != FULL as PORTAL, because
            // LIMITED (no upstream route after the default gateway) is easy to obtain
            // with a tethered phone
            // NONE is also possible, with a connection configured to force no default route
            // (but in general we should only prompt a portal if we know there is a portal)
            if (GLib.getenv('GNOME_SHELL_CONNECTIVITY_TEST') != null)
                isPortal ||= this._client.connectivity < NM.ConnectivityState.FULL;
            if (!isPortal)
                return;

            const path = this._mainConnection.get_path();
            if (this._connectivityQueue.has(path))
                return;

            const timestamp = global.get_current_time();
            if (!this._portalHelperProxy) {
                this._portalHelperProxy = new Gio.DBusProxy({
                    g_connection: Gio.DBus.session,
                    g_name: 'org.gnome.Shell.PortalHelper',
                    g_object_path: '/org/gnome/Shell/PortalHelper',
                    g_interface_name: PortalHelperInfo.name,
                    g_interface_info: PortalHelperInfo,
                });
                this._portalHelperProxy.connectSignal('Done',
                    () => this._portalHelperDone().catch(logError));

                try {
                    await this._portalHelperProxy.init_async(
                        GLib.PRIORITY_DEFAULT, null);
                } catch (e) {
                    console.error(`Error launching the portal helper: ${e.message}`);
                }
            }

            this._portalHelperProxy?.AuthenticateAsync(path, this._client.connectivity_check_uri, timestamp).catch(logError);

            this._connectivityQueue.add(path);
        }

        async _getIpInfo() {
            this._setAcquiringDetials();

            this._vpnConnectionOn = false;
            this._vpnConnectionName = null;

            if (this._client.connectivity === NM.ConnectivityState.NONE) {
                this._setIpDetails();
                return;
            }

            // Hard-coded: VPN connection types to detect
            const handledTypes = ['vpn', 'wireguard', 'tun'];
            const whiteList = [];

            const activeConnectionIds = [];
            const activeConnections = this._client.get_active_connections() || [];

            debugLog('IP-Finder Log');
            debugLog('Active Connections--------------------------');
            activeConnections.forEach(a => {
                activeConnectionIds.push(a.id);
                if (a.state === NM.ActiveConnectionState.ACTIVATED && (handledTypes.includes(a.type) || whiteList.includes(a.id))) {
                    debugLog(`VPN Connection: '${a.id}', Type: '${a.type}'`);
                    this._vpnConnectionOn = true;
                    this._vpnConnectionName = a.id;
                } else {
                    debugLog(`Connection: '${a.id}', Type: '${a.type}'`);
                }
            });
            debugLog('--------------------------------------------');
            debugLog('');

            if (activeConnections.length < 1) {
                this._setIpDetails();
                return;
            }

            // Use multi-API fallback system
            const { data, error, apiUsed } = await Utils.getIPDetails(this._session, this._extension.path);
            if (apiUsed) {
                debugLog(`Successfully fetched IP details from ${apiUsed}`);
            }
            this._setIpDetails(data, error);
        }

        _setAcquiringDetials() {
            this._flagIcon.hide();
            this._statusIcon.show();
            this._ipAddressLabel.text = this._defaultIpData.ip.text;
            this._ipAddressLabel.style_class = 'system-status-icon';
            this._statusIcon.icon_name = 'network-wired-acquiring-symbolic';
            this._vpnStatusIcon.style_class = 'system-status-icon';
            this._vpnStatusIcon.hide();
            this._vpnInfoBox.hide();
        }

        _setIpDetails(data, error) {
            this._ipInfoBox.destroy_all_children();

            // null data indicates no connection found or error in gathering ip info
            if (!data) {
                this._ipAddressLabel.style_class = 'system-status-icon';
                this._ipAddressLabel.text = error ? 'Error!' : 'No Connection';
                this._statusIcon.show();
                this._statusIcon.icon_name = 'network-offline-symbolic';
                this._vpnStatusIcon.style_class = 'system-status-icon';

                const ipInfoRow = new St.BoxLayout();
                this._ipInfoBox.add_child(ipInfoRow);

                const label = new St.Label({
                    style_class: 'ip-info-key',
                    text: error ? `${error}` : 'No Connection',
                    x_align: Clutter.ActorAlign.CENTER,
                    x_expand: true,
                });
                ipInfoRow.add_child(label);

                return;
            }

            this._statusIcon.hide();

            this._ipAddress = data.ip;
            this._ipAddressLabel.text = this._ipAddress;

            // Always show flag (hard-coded)
            const flagEmoji = getFlagEmoji(data.countryCode, this._countryFlags);
            if (flagEmoji) {
                this._flagIcon.text = flagEmoji;
                this._flagIcon.show();
            } else {
                this._flagIcon.hide();
            }

            this._vpnInfoBox.setVpnStatus({
                vpnOn: this._vpnConnectionOn,
                iconPath: this._vpnConnectionOn ? 'changes-prevent-symbolic' : 'changes-allow-symbolic',
                vpnName: this._vpnConnectionName ? this._vpnConnectionName : 'On',
                styleClass: this._vpnConnectionOn ? 'ip-info-vpn-on' : 'ip-info-vpn-off',
            });

            this._updatePanelWidgets();
            this._updateVPNWidgets();

            this._ipInfoBox.add_child(new PopupMenu.PopupSeparatorMenuItem());

            // Display all available fields
            for (const key in this._defaultIpData) {
                // Get the value from data, handling null/undefined
                const value = data[key];

                // Skip if value is null or undefined (API doesn't provide this field)
                if (value === null || value === undefined) {
                    continue;
                }

                const ipInfoRow = new St.BoxLayout();
                this._ipInfoBox.add_child(ipInfoRow);

                const label = new St.Label({
                    style_class: 'ip-info-key',
                    text: `${this._defaultIpData[key].name}: `,
                    x_align: Clutter.ActorAlign.FILL,
                    y_align: Clutter.ActorAlign.CENTER,
                    y_expand: true,
                });
                ipInfoRow.add_child(label);

                const infoLabel = new St.Label({
                    x_align: Clutter.ActorAlign.FILL,
                    y_align: Clutter.ActorAlign.CENTER,
                    x_expand: true,
                    y_expand: true,
                    style_class: 'ip-info-value',
                    text: value,
                });
                const dataLabelBtn = new St.Button({
                    child: infoLabel,
                });
                dataLabelBtn.connect('button-press-event', () => {
                    this._setClipboardText(dataLabelBtn.child.text);
                });
                ipInfoRow.add_child(dataLabelBtn);
            }

            this._ipInfoBox.add_child(new PopupMenu.PopupSeparatorMenuItem());
        }

        disable() {
            this._removeGetIpInfoId();

            this._client?.disconnectObject(this);

            this._settings = null;
        }
    });

export default class IpFinder extends Extension {
    enable() {
        this.soupParams = {
            id: `ip-finder/'v${this.metadata.version}`,
        };
        this._menuButton = new IPFinderMenuButton(this);
    }

    disable() {
        this.soupParams = null;
        this._menuButton.disable();
        this._menuButton.destroy();
        this._menuButton = null;
    }
}
