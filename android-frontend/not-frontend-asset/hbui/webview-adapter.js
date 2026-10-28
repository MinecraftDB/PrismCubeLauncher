/*
 * OreUI WebView runtime adapter.
 *
 * This file intentionally contains no React/UI components. It supplies the native
 * services that Minecraft's embedded browser normally provides, while preserving
 * the original OreUI bundles and component tree.
 */
(function () {
    "use strict";

    if (window.OreUIWebView && window.OreUIWebView.installed) return;

    var VERSION = 1;
    var nextRequestId = 1;
    var listeners = Object.create(null);
    var querySubscriptions = Object.create(null);
    var commandCache = Object.create(null);
    var nativeBridge = window.AndroidBridge || null;

    // Load the untouched OreUI stylesheets as text and rewrite only Minecraft's
    // native resource URLs. Style elements are installed in the original order.
    // This intentionally targets HTTP(S) WebView hosting, not file:// CORS.
    if (window.fetch) {
        Array.prototype.forEach.call(document.querySelectorAll("link[data-oreui-css]"), function (link) {
            var href = link.getAttribute("href");
            var style = document.createElement("style");
            style.setAttribute("data-oreui-runtime-css", href);
            link.parentNode.replaceChild(style, link);
            fetch(href, { credentials: "same-origin" }).then(function (response) {
                if (!response.ok) throw new Error("CSS HTTP " + response.status);
                return response.text();
            }).then(function (css) {
                style.textContent = css
                    .split("ui://hbui/").join("./")
                    .split("ui:/./").join("./")
                    .split("/hbui/").join("./");
            }).catch(function (error) {
                console.warn("[OreUIWebView] Could not adapt stylesheet " + href, error);
            });
        });
    }

    function cloneArgs(args) {
        return Array.prototype.slice.call(args);
    }

    function emit(name, args) {
        var callbacks = (listeners[name] || []).slice();
        callbacks.forEach(function (callback) {
            try {
                callback.apply(null, args || []);
            } catch (error) {
                // Keep one native event from preventing the remaining OreUI listeners.
                setTimeout(function () { throw error; }, 0);
            }
        });
    }

    function post(type, name, args, extra) {
        var request = Object.assign({
            version: VERSION,
            id: String(nextRequestId++),
            source: "oreui-webview",
            type: type,
            name: name,
            args: args || [],
            timestamp: Date.now()
        }, extra || {});

        /*
         * Kotlin contract (register with webView.addJavascriptInterface):
         *
         * class OreUIAndroidBridge(private val activity: Activity) {
         *   @JavascriptInterface
         *   fun dispatch(requestJson: String): String? {
         *     // Parse requestJson, then forward it through your JNI method to Rust.
         *     // Rust may perform downloads, archive parsing, world queries, etc.
         *     // Return a JSON string such as {"result": ...} for a synchronous
         *     // command result, or null when the operation is asynchronous.
         *     return rustJniDispatch(requestJson)
         *   }
         * }
         *
         * For async Rust completions, switch to the Android UI thread and call:
         * webView.evaluateJavascript(
         *   "window.OreUIWebView.receive(" + JSONObject.quote(responseJson) + ")",
         *   null
         * )
         *
         * Supported response envelopes are documented by receive() below. Never
         * invoke evaluateJavascript on a JNI worker thread.
         */
        if (!nativeBridge) return undefined;
        try {
            if (typeof nativeBridge.dispatch === "function") {
                var raw = nativeBridge.dispatch(JSON.stringify(request));
                // Kotlin returns null for asynchronous work; that must not hide
                // the local fallback (notably translations and boolean checks).
                if (raw === null || raw === undefined) return undefined;
                if (typeof raw !== "string" || raw.length === 0) return raw;
                var response = JSON.parse(raw);
                if (response && Object.prototype.hasOwnProperty.call(response, "result")) {
                    return response.result;
                }
                return response;
            }
            // Optional compatibility with an existing Kotlin bridge that exposes
            // postMessage(String) instead of dispatch(String).
            if (typeof nativeBridge.postMessage === "function") {
                nativeBridge.postMessage(JSON.stringify(request));
            }
        } catch (error) {
            console.warn("[OreUIWebView] AndroidBridge dispatch failed", error);
        }
        return undefined;
    }

    function makeLocation(pathname) {
        var value = pathname || "/";
        var hashIndex = value.indexOf("#");
        var searchIndex = value.indexOf("?");
        var pathEnd = value.length;
        if (hashIndex >= 0) pathEnd = Math.min(pathEnd, hashIndex);
        if (searchIndex >= 0) pathEnd = Math.min(pathEnd, searchIndex);
        return {
            pathname: value.slice(0, pathEnd) || "/",
            search: searchIndex >= 0 ? value.slice(searchIndex, hashIndex >= 0 ? hashIndex : value.length) : "",
            hash: hashIndex >= 0 ? value.slice(hashIndex) : "",
            state: ""
        };
    }

    // OreUI's native router facet contains callable history methods. Keep that
    // contract in JS; JSON-only native responses cannot supply these functions.
    var routerHistory = {
        action: "POP",
        list: [makeLocation("/")],
        length: 1,
        push: function (path) { navigate("PUSH", path); },
        replace: function (path) { navigate("REPLACE", path); },
        goBack: function () { navigate("POP", null, -1); },
        go: function (delta) { navigate("POP", null, delta || 0); }
    };

    var routerFacet = { history: routerHistory };

    function navigate(action, path, delta) {
        if (action === "POP") {
            var nextIndex = Math.max(0, routerHistory.list.length - 1 + (delta || -1));
            routerHistory.list = routerHistory.list.slice(0, nextIndex + 1);
        } else if (action === "REPLACE") {
            routerHistory.list = routerHistory.list.slice(0, -1).concat(makeLocation(path));
        } else {
            routerHistory.list = routerHistory.list.concat(makeLocation(path));
        }
        routerHistory.action = action;
        routerHistory.length = routerHistory.list.length;
        post("router.navigate", "core.router", [{
            action: action,
            path: path || null,
            delta: delta || 0,
            location: routerHistory.list[routerHistory.list.length - 1]
        }]);
        queueMicrotask(function () {
            emit("facet:updated:core.router", [routerFacet]);
        });
    }

    function deviceInformation() {
        return {
            // OreUI treats these as native enum values. Keyboard + touch are
            // sufficient for an ordinary Android WebView.
            inputMethods: [0, 1, 2],
            platform: 0
        };
    }

    function displayInformation() {
        return {
            displayWidth: Math.max(1, window.innerWidth),
            displayHeight: Math.max(1, window.innerHeight),
            pixelsPerMillimeter: 3.779527559,
            guiScaleBase: 2,
            guiScaleModifier: 0,
            guiAccessibilityScaling: false
        };
    }

    function defaultQuery(name, params) {
        switch (name) {
            case "core.locale": return { locale: "en-US" };
            case "core.commandState": return 0; // Idle
            case "core.animation": return { screenAnimationEnabled: false };
            case "core.splitScreen":
                return { numActivePlayers: 1, splitScreenDirection: 0, splitScreenPosition: 0 };
            case "core.input":
                return {
                    currentInputType: 1,
                    interactionModelLocked: false,
                    swapABButtons: false,
                    swapXYButtons: false,
                    enableControllerHints: false,
                    keyboardType: 0
                };
            case "core.device.display": return displayInformation();
            case "core.device.network":
                return {
                    isOnline: true,
                    showCellularDataFee: false,
                    onlyCellularAvailable: false,
                    supportsManualAddedServers: true,
                    isLANAllowed: true,
                    defaultNetworkMaxPlayers: 8,
                    isAdHocModeActive: false
                };
            case "core.device.storage":
                return {
                    isUsingExternalStorage: false,
                    isUsingAppDataStorage: true,
                    supportsSizeQuery: true,
                    storageSize: 0,
                    storageUsed: 0,
                    storageAvailableSize: "0 GB",
                    isStorageFull: false,
                    isStorageLow: false
                };
            case "core.cloudStorage":
                return {
                    cloudStorageSupported: false,
                    storageSize: 0,
                    storageUsed: 0,
                    storageAvailableSize: "0 GB",
                    isStorageFull: false,
                    isStorageLow: false
                };
            case "core.safeZone":
                return { safeAreaX: 0, safeAreaY: 0, screenPositionX: 0, screenPositionY: 0 };
            case "core.screenReader": return { enabled: false, mode: 0 };
            case "core.featureToggle":
            case "core.staticFeatureFlag":
            case "core.flightingToggle": return { enabled: false };
            case "core.flightingConfig.bool": return { value: false };
            case "core.flightingConfig.number": return { value: 0 };
            case "core.flightingConfig.string": return { value: "" };
            case "core.option.float": return { value: 0 };
            case "vanilla.currentParty.dataQuery": return { isInParty: false };
            case "vanilla.currentParty.membersQuery": return { members: [], leaderXuid: "" };
            case "vanilla.partyChat.enabledQuery": return { enabled: false };
            case "vanilla.partyChat.unreadMessagesQuery": return { unreadMessages: 0 };
            default: return {};
        }
    }

    function facetMethod(facetName, methodName, fallback) {
        return function () {
            var result = post("facet.method", facetName + "." + methodName, cloneArgs(arguments), {
                facet: facetName,
                method: methodName
            });
            if (result !== undefined) return result;
            return typeof fallback === "function" ? fallback.apply(null, arguments) : fallback;
        };
    }

    function createNewWorldFacet() {
        var name = "vanilla.createNewWorld";
        return {
            worldData: {
                general: {
                    worldName: "New World",
                    gameMode: 0, // Survival
                    difficulty: 2, // Normal
                    isHardcore: false,
                    playerHasDied: false
                },
                multiplayer: {
                    multiplayerGame: true,
                    playerAccess: 2, // Friends
                    playerPermissions: 1, // Member
                    generalWarningState: 0
                },
                advanced: {
                    worldSeed: "",
                    generatorType: 1, // Overworld
                    useFlatWorld: false
                },
                cheats: { cheatsEnabled: false },
                betaFeatures: [],
                isUsingTemplate: false,
                isLockedTemplate: false,
                achievementsDisabled: false,
                achievementsPermanentlyDisabled: false
            },
            isEditorWorld: false,
            worldPreviewImagePath: "",
            createWorldError: null,
            createOnRealmsError: null,
            consumeResetFlag: false,
            isCreatingWorld: false,
            isRandomSeedAllowed: true,
            applyTemplateTaskState: 0,
            inWorldCreation: false,
            clearErrors: facetMethod(name, "clearErrors"),
            unlockTemplateSettings: facetMethod(name, "unlockTemplateSettings"),
            checkIfUserHasChangedSettings: facetMethod(name, "checkIfUserHasChangedSettings", false),
            createWorld: facetMethod(name, "createWorld"),
            createOnRealms: facetMethod(name, "createOnRealms"),
            applyTemplate: facetMethod(name, "applyTemplate")
        };
    }

    function resourcePacksFacet() {
        var name = "vanilla.resourcePacks";
        return {
            prompt: { active: false },
            status: 0,
            resourcePackToDownload: { title: "" },
            downloadProgress: 0,
            importProgress: 0,
            availableTexturePacks: [],
            availableBehaviorPacks: [],
            activeTexturePacks: [],
            activeBehaviorPacks: [],
            lastActivatedPackId: null,
            activate: facetMethod(name, "activate"),
            deactivate: facetMethod(name, "deactivate"),
            changePackPriority: facetMethod(name, "changePackPriority"),
            showSettings: facetMethod(name, "showSettings"),
            cancelDownload: facetMethod(name, "cancelDownload"),
            clearLastActivatedPackId: facetMethod(name, "clearLastActivatedPackId")
        };
    }

    function defaultFacet(name) {
        if (name === "core.router") return routerFacet;
        if (name === "core.deviceInformation") return deviceInformation();
        if (name === "vanilla.createNewWorld") return createNewWorldFacet();
        if (name === "vanilla.resourcePacks") return resourcePacksFacet();
        if (name === "vanilla.userAccount") {
            return {
                isTrialAccount: false,
                isLoggedInWithMicrosoftAccount: false,
                isSignedInPlatformNetwork: true,
                isBanned: false,
                currentXuid: "",
                userPermissions: { multiplayer: { denyReasons: [] } },
                openLink: facetMethod(name, "openLink"),
                updateMultiplayerPrivilegeUsingSystemModal: facetMethod(name, "updateMultiplayerPrivilegeUsingSystemModal")
            };
        }
        if (name === "vanilla.notifications") {
            return { queueSnackbar: facetMethod(name, "queueSnackbar") };
        }
        if (name === "vanilla.telemetry") {
            return {
                fireEventButtonPressed: facetMethod(name, "fireEventButtonPressed"),
                trackOptionChanged: facetMethod(name, "trackOptionChanged")
            };
        }
        if (name === "vanilla.buildSettings") {
            return {
                isDevBuild: false,
                isAnyBeta: false,
                developmentVersion: "",
                currentGameVersion: { major: 0, minor: 0, patch: 0, revision: 0 }
            };
        }
        if (name === "vanilla.notificationOptions") {
            return {
                doNotShowHardcoreModeWarning: false,
                doNotShowAddonStackingWarning: false
            };
        }
        return undefined;
    }

    function localCommand(namespace, name, args) {
        if (namespace === "coreTranslateCommandGroup") {
            if (name === "translate") {
                var key = args.length ? String(args[0]) : "";
                var translations = window.OreUITranslations || {};
                var text = Object.prototype.hasOwnProperty.call(translations, key)
                    ? translations[key]
                    : key;
                var replacements = args[1];
                if (Array.isArray(replacements)) {
                    replacements.forEach(function (replacement, index) {
                        text = text.split("{" + index + "}").join(String(replacement));
                    });
                }
                return text;
            }
            if (name === "formatDate") return args.length ? String(args[0]) : "";
            if (name === "getHowLongAgoAsString") return "";
        }
        return undefined;
    }

    function command(namespace, name) {
        var cacheKey = namespace + "." + name;
        if (commandCache[cacheKey]) return commandCache[cacheKey];
        var entry = {
            id: commandCache.__nextId = (commandCache.__nextId || 0) + 1,
            callable: function () {
                var args = cloneArgs(arguments);
                var nativeResult = post("command", namespace + "." + name, args, {
                    namespace: namespace,
                    command: name
                });
                return nativeResult === undefined ? localCommand(namespace, name, args) : nativeResult;
            }
        };
        commandCache[cacheKey] = entry;
        return entry;
    }

    // The original bundle reads window.__commands__[group][name] directly.
    // Nested Proxies preserve that API without maintaining a brittle command list.
    var commandNamespaces = new Proxy(Object.create(null), {
        get: function (target, namespace) {
            if (typeof namespace !== "string") return undefined;
            if (!target[namespace]) {
                target[namespace] = new Proxy(Object.create(null), {
                    get: function (commands, name) {
                        return typeof name === "string" ? command(namespace, name) : undefined;
                    }
                });
            }
            return target[namespace];
        }
    });

    var engine = {
        on: function (name, callback) {
            if (typeof callback !== "function") return;
            (listeners[name] || (listeners[name] = [])).push(callback);
        },
        off: function (name, callback) {
            var callbacks = listeners[name];
            if (!callbacks) return;
            listeners[name] = callbacks.filter(function (candidate) { return candidate !== callback; });
        },
        trigger: function (name) {
            var args = cloneArgs(arguments).slice(1);
            var nativeResult = post("engine.trigger", name, args);

            // Local bootstrap values make the original UI render before Rust has
            // supplied real data. Native facet/query updates can replace them later.
            if (name === "facet:request") {
                var facetName = args[0];
                var facetValue = defaultFacet(facetName);
                queueMicrotask(function () {
                    if (facetValue !== undefined) {
                        emit("facet:updated:" + facetName, [facetValue]);
                    } else {
                        // OreUI uses this native error to activate its own fallback.
                        emit("facet:error:" + facetName, ["activate-facet-not-found"]);
                    }
                });
            } else if (name.indexOf("query:subscribe/") === 0) {
                var queryName = name.slice("query:subscribe/".length);
                var subscriptionId = String(args[0]);
                var subscriptions = querySubscriptions[queryName] || (querySubscriptions[queryName] = Object.create(null));
                subscriptions[subscriptionId] = true;
                var queryValue = defaultQuery(queryName, args.slice(1));
                queueMicrotask(function () {
                    emit("query:subscribed/" + subscriptionId, [queryValue]);
                });
            } else if (name === "query:unsubscribe") {
                var removedId = String(args[0]);
                Object.keys(querySubscriptions).forEach(function (queryName) {
                    delete querySubscriptions[queryName][removedId];
                });
            }
            return nativeResult;
        }
    };

    function receive(message) {
        var data = typeof message === "string" ? JSON.parse(message) : message;
        if (!data || typeof data !== "object") return;
        var name = data.name || data.id;
        var value = Object.prototype.hasOwnProperty.call(data, "value") ? data.value : data.result;
        switch (data.type) {
            case "engine.event": emit(name, data.args || []); break;
            case "facet.updated":
            case "facet:updated":
                if (name === "core.router" && value && value.history) {
                    // Preserve callable history methods when Kotlin sends a snapshot.
                    routerHistory.list = value.history.list || routerHistory.list;
                    routerHistory.action = value.history.action || routerHistory.action;
                    routerHistory.length = routerHistory.list.length;
                    value = routerFacet;
                }
                emit("facet:updated:" + name, [value]);
                break;
            case "facet.error":
            case "facet:error": emit("facet:error:" + name, [data.error]); break;
            case "query.subscribed":
            case "query:subscribed": emit("query:subscribed/" + name, [value]); break;
            case "query.updated":
            case "query:updated": emit("query:updated/" + name, [value]); break;
            default:
                console.warn("[OreUIWebView] Unknown native response type", data.type);
        }
    }

    window.engine = engine;
    window.__commands__ = commandNamespaces;
    window.OreUIWebView = Object.freeze({
        installed: true,
        version: VERSION,
        receive: receive,
        // Alias kept explicit for Kotlin/JNI integration code.
        dispatchNativeResponse: receive,
        emit: function (name) { emit(name, cloneArgs(arguments).slice(1)); },
        updateFacet: function (name, value) {
            receive({ type: "facet.updated", name: name, value: value });
        },
        updateQuery: function (id, value) {
            receive({ type: "query.updated", id: id, value: value });
        },
        hasAndroidBridge: function () { return !!nativeBridge; }
    });

    window.addEventListener("resize", function () {
        var value = displayInformation();
        var subscriptions = querySubscriptions["core.device.display"] || {};
        Object.keys(subscriptions).forEach(function (subscriptionId) {
            receive({ type: "query.updated", id: subscriptionId, value: value });
        });
        // Also let Kotlin/Rust and the diagnostics layer observe the new size.
        post("webview.resize", "core.device.display", [value]);
    });
})();
