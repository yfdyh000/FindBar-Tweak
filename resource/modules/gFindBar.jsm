Modules.VERSION = '1.1.8';

this.__defineGetter__('gFindBar', function() { return window.gFindBar || $('FindToolbar'); });
this.__defineGetter__('gFindBarInitialized', function() { return FITFull || viewSource || window.gFindBarInitialized; });
this.__defineGetter__('gBrowser', function() { return window.gBrowser; });
this.__defineGetter__('browserPanel', function() { return $('browser-panel') || viewSource || FITFull; });

this.__defineGetter__('findQuery', function() { return gFindBar._findField.value; });
this.__defineSetter__('findQuery', function(v) { return gFindBar._findField.value = v; });

this.currentTab = null;
this.tabSelectBaseListener = function() {
	dispatch(gBrowser.tabContainer, { type: 'TabSelectPrevious', cancelable: false });
	currentTab = gBrowser.mCurrentTab;
};

this.baseInit = function(bar) {
	// Since in-content we can't know it's a view-source browser before it's actually loaded, and the scripts are loaded before the browser does,
	// we need to explicitely tell our content scripts their in a view-source browser.
	if(viewSource) {
		Messenger.loadInBrowser(bar.browser, 'viewSource');
	}
	
	Messenger.loadInBrowser(bar.browser, 'gFindBar');
	
	if(!FITFull) {
		// _findMode is already a getter of __findMode, but because of the way it's implemented (property node in xbl binding), I also need to set the getter as well
		bar._findMode_originalSetter = bar.__lookupSetter__('_findMode');
		bar._findMode_originalGetter = bar.__lookupGetter__('_findMode');
		bar.__defineGetter__('_findMode', function() { return this.__findMode; });
		bar.__defineSetter__('_findMode', function(v) {
			if(this.__findMode != v) {
				let previous = this.__findMode;
				this.__findMode = v;
				dispatch(this, { type: 'FindModeChange', cancelable: false, detail: { before: previous, after: v } });
			}
			
			// as in original setter
			this._updateBrowserWithState();
			
			return v;
		});
			
		Piggyback.add('gFindBar', bar, 'open', function(aMode) {
			var suffix = (!viewSource && this.browser != gBrowser.mCurrentBrowser) ? 'Background' : '';
			
			if(dispatch(this, { type: 'WillOpenFindBar'+suffix, detail: aMode })) {
				var ret = this._open(aMode);
				
				Messenger.messageBrowser(this.browser, 'FindBar:State', true);
				dispatch(this, { type: 'OpenedFindBar'+suffix, cancelable: false, detail: aMode });
				return ret;
			}
			return false;
		});
		
		Piggyback.add('gFindBar', bar, '_updateFindUI', function() {
			var suffix = (!viewSource && this.browser != gBrowser.mCurrentBrowser) ? 'Background' : '';
			
			if(dispatch(this, { type: 'WillUpdateUIFindBar'+suffix })) {
				this.__updateFindUI();
				dispatch(this, { type: 'UpdatedUIFindBar'+suffix, cancelable: false });
			}
		});
		
		Piggyback.add('gFindBar', bar, '_updateStatusUI', function(res, aFindPrevious) {
			var suffix = (!viewSource && this.browser != gBrowser.mCurrentBrowser) ? 'Background' : '';
			
			if(dispatch(this, { type: 'WillUpdateStatusFindBar'+suffix, detail: { res: res, aFindPrevious: aFindPrevious } })) {
				this.__updateStatusUI(res, aFindPrevious);
				this._findStatusDesc.hidden = !this._findStatusDesc.textContent;
				this._findStatusIcon.hidden = !this._findStatusIcon.getAttribute('status');
				dispatch(this, { type: 'UpdatedStatusFindBar'+suffix, cancelable: false, detail: { res: res, aFindPrevious: aFindPrevious } });
			}
		});
		
		// this acts as a fake-handleEvent for these events carried from content
		Piggyback.add('gFindBar', bar, 'receiveMessage', function(aMessage) {
			if(aMessage.target != this._browser) { return; }
			
			switch(aMessage.name) {
				case "Findbar:Mouseup":
					if(!this.hidden && this._findMode != this.FIND_NORMAL
					// this receiver would prevent fillSelectedText from showing the quick findbar, because it would close it
					// right after it opened. We obviously don't want the Mouseup from going through if it's meant as a text selection action
					&& !this._keepOpen) {
						this.close();
					}
					break;
				
				case "Findbar:Keypress":
					return this._onBrowserKeypress(aMessage.data);
			}
		});
	}
	
	Piggyback.add('gFindBar', bar, 'close', function() {
		if(FITFull) {
			window.close();
			return;
		}
		
		// don't let Firefox's fullscreen handler close the findbar, instead we hide it through CSS so it is still there after exiting fullscreen
		if(!viewSource && trueAttribute(document.documentElement, 'inDOMFullscreen')) {	return; }
		
		var suffix = (!viewSource && this.browser != gBrowser.mCurrentBrowser) ? 'Background' : '';
		
		if(dispatch(this, { type: 'WillCloseFindBar'+suffix })) {
			this._close();
			Messenger.messageBrowser(this.browser, 'FindBar:State', false);
			dispatch(this, { type: 'ClosedFindBar'+suffix, cancelable: false });
		}
	});
	
	Piggyback.add('gFindBar', bar, '_find', function(aValue, wasPrefill) {
		// sync the find value with content
		Messenger.messageBrowser(this.browser, 'FindBar:Query', this._findField.value);
		
		let val = aValue || this._findField.value;
		let suffix = (!FITFull && !viewSource && this.browser != gBrowser.mCurrentBrowser) ? 'Background' : '';
		
		if(dispatch(this, { type: 'WillFindFindBar'+suffix, detail: val })) {
			if(!this._dispatchFindEvent("")) { return; }
			
			if(!viewSource) {
				gBrowser._lastFindValue = val;
			}
			
			// We have to carry around an explicit version of this, because finder.searchString doesn't update on failed searches.
			this.browser._lastSearchString = val;
			
			// Only search on input if we don't have a last-failed string, or if the current search string doesn't start with it.
			// https://bugzilla.mozilla.org/show_bug.cgi?id=926033
			if(!this._findFailedString || !val.startsWith(this._findFailedString)) {
				// only resolve this when we will actually find something;
				// usually gFindBar.onCurrentSelection is what takes care of focusing and selecting the find query,
				// but at this point the findbar should always already be focused (done sync in startFind()) and selected (done sync in perTab.jsm and globalFB.jsm)
				if(val && this._startFindDeferred) {
					this._startFindDeferred.resolve();
					this._startFindDeferred = null;
				}
				
				// when running immediate finds after opening the findbar and prefilling it, some things don't need to happen,
				// such as sights on the current hit
				if(wasPrefill) {
					Messenger.messageBrowser(this.browser, 'Sights.doCurrent', true);
				}
				
				this._enableFindButtons(val);
				
				this._updateCaseSensitivity(val);
				this.browser.finder.tweakFastFind(val, this._findMode == this.FIND_LINKS, this._findMode != this.FIND_NORMAL);
				
				// We always set the highlight timeout when performing a new find, otherwise the counter would not be updated.
				// Whether the highlights themselves are placed or not will be controlled further down the chain.
				this._setHighlightTimeout();
			}
			
			if(this._findMode != this.FIND_NORMAL) {
				this._setFindCloseTimeout();
			}
			
			if(this._findResetTimeout != -1) {
				window.clearTimeout(this._findResetTimeout);
			}
			
			// allow a search to happen on input again after a second has expired since the previous input, to allow for dynamic content and/or page loading
			this._findResetTimeout = window.setTimeout(() => {
				this._findFailedString = null;
				this._findResetTimeout = -1;
			}, 1000);
		}
	});
	
	Piggyback.add('gFindBar', bar, '_findAgain', function(aFindPrevious) {
		var suffix = (!viewSource && this.browser != gBrowser.mCurrentBrowser) ? 'Background' : '';
		
		if(dispatch(this, { type: 'WillFindAgain'+suffix, detail: { aFindPrevious: aFindPrevious } })) {
			this.browser.finder.findAgain(aFindPrevious, this._findMode == this.FIND_LINKS, this._findMode != this.FIND_NORMAL);
			dispatch(this, { type: 'FoundAgain'+suffix, cancelable: false, detail: { aFindPrevious: aFindPrevious } });
		}
	});
	
	Piggyback.add('gFindBar', bar, 'onFindAgainCommand', function(aFindPrevious) {
		var suffix = (!viewSource && this.browser != gBrowser.mCurrentBrowser) ? 'Background' : '';
		
		if(dispatch(this, { type: 'WillFindAgainCommand'+suffix, detail: { aFindPrevious: aFindPrevious } })) {
			this._onFindAgainCommand(aFindPrevious);
		}
	});
	
	// sync the current findQuery
	Messenger.messageBrowser(bar.browser, 'FindBar:Query', bar._findField.value);
	
	// Changing the pref doesn't automatically update this value
	bar.__quickFindTimeoutLength = bar._quickFindTimeoutLength;
	delete bar._quickFindTimeoutLength;
	bar.__defineGetter__('_quickFindTimeoutLength', function() { return Prefs.FAYTtimeout; });
	
	// We completely override Firefox's own matches counter with ours
	Piggyback.add('gFindBar', bar, '_updateMatchesCount', function() {});
	bar._foundMatches.value = '';
	bar._foundMatches.hidden = true;
	
	// opening the findbar is a somewhat asynchronous process, it needs to fetch the value to prefill from content,
	// if the user types in the findbar after it's opened, but before the prefill value is fetched, it can lead to some weirdness with the search query
	// see https://github.com/Quicksaver/FindBar-Tweak/issues/198 and https://bugzilla.mozilla.org/show_bug.cgi?id=1198465
	Piggyback.add('gFindBar', bar, 'onCurrentSelection', function(aSelectionString, aIsInitialSelection) {
		// no-op in case something resolved and nulled startFindDeferred in the meantime
		return !aIsInitialSelection || this._startFindDeferred;
	}, Piggyback.MODE_BEFORE);
	
	// keypresses are communicated through a message sent from content
	Piggyback.add('gFindBar', bar, '_onBrowserKeypress', function(aFakeEvent) {
		// in theory, fast keypresses could stack up when the process is slow/hanging, especially in e10s-code which has a high degree of asynchronicity here.
		// we should make sure the findbar isn't "opened" several times, otherwise it could lead to erroneous find queries
		// see https://github.com/Quicksaver/FindBar-Tweak/issues/198 and https://bugzilla.mozilla.org/show_bug.cgi?id=1198465
		if(!this.hidden && document.activeElement == this._findField.inputField) {
			this._dispatchKeypressEvent(this._findField.inputField, aFakeEvent);
			return false;
		}
		
		let FAYT_LINKS_KEY = "'";
		let FAYT_TEXT_KEY = "/";
		
		if(this._findMode != this.FIND_NORMAL && this._quickFindTimeout) {
			if(!aFakeEvent.charCode) {
				return true;
			}
			
			this._findField.select();
			this._findField.focus();
			this._dispatchKeypressEvent(this._findField.inputField, aFakeEvent);
			return false;
		}
		
		let key = aFakeEvent.charCode ? String.fromCharCode(aFakeEvent.charCode) : null;
		let manualstartFAYT = (key == FAYT_LINKS_KEY || key == FAYT_TEXT_KEY);
		let autostartFAYT = !manualstartFAYT && Prefs.FAYTenabled && key && key != " ";
		if(manualstartFAYT || autostartFAYT) {
			let mode = (key == FAYT_LINKS_KEY || (autostartFAYT && this._typeAheadLinksOnly)) ? this.FIND_LINKS : this.FIND_TYPEAHEAD;
			
			// Clear bar first, so that when open() calls setCaseSensitivity() it doesn't get confused by a lingering value
			this._findField.value = "";
			
			this.open(mode);
			this._setFindCloseTimeout();
			this._findField.select();
			this._findField.focus();
			
			if(autostartFAYT) {
				this._dispatchKeypressEvent(this._findField.inputField, aFakeEvent);
			} else {
				this._updateStatusUI(this.nsITypeAheadFind.FIND_FOUND);
			}
			
			return false;
		}
	});
};

this.baseDeinit = function(bar) {
	if(!bar._destroying) {
		if(!FITFull) {
			bar.__defineGetter__('_findMode', bar._findMode_originalGetter);
			bar.__defineSetter__('_findMode', bar._findMode_originalSetter);
			delete bar._findMode_originalGetter;
			delete bar._findMode_originalSetter;
			
			Piggyback.revert('gFindBar', bar, 'open');
			Piggyback.revert('gFindBar', bar, 'close');
			Piggyback.revert('gFindBar', bar, '_updateFindUI');
			Piggyback.revert('gFindBar', bar, '_updateStatusUI');
			Piggyback.revert('gFindBar', bar, 'receiveMessage');
			
			bar._findStatusDesc.hidden = false;
			bar._findStatusIcon.hidden = false;
		}
		
		delete bar._quickFindTimeoutLength;
		bar._quickFindTimeoutLength = bar.__quickFindTimeoutLength;
		delete bar.__quickFindTimeoutLength;
		
		Piggyback.revert('gFindBar', bar, '_find');
		Piggyback.revert('gFindBar', bar, '_findAgain');
		Piggyback.revert('gFindBar', bar, 'onFindAgainCommand');
		Piggyback.revert('gFindBar', bar, '_updateMatchesCount');
		Piggyback.revert('gFindBar', bar, 'onCurrentSelection');
		Piggyback.revert('gFindBar', bar, '_onBrowserKeypress');
		
		// this should always be resolved just after opening the sidebar,
		// but in case any of our initialization listeners hangs around for some reason, better ret rid of it
		if(bar._startFindDeferred) {
			bar._startFindDeferred.reject();
			bar._startFindDeferred = null;
		}
	}
	
	Messenger.unloadFromBrowser(bar.browser, 'gFindBar');
	Messenger.unloadFromBrowser(bar.browser, 'viewSource');
};

// Support for per-tab findbar introduced in FF25.
this.initRoutines = {};

this.initFindBar = function(name, init, deinit, force) {
	if(!force && initRoutines[name]) { return; }
	initRoutines[name] = { init: init, deinit: deinit };
	
	if(FITFull || viewSource) {
		initFindBarRoutine(gFindBar, name, init, force);
	} else {
		for(let tab of gBrowser.tabs) {
			if(gBrowser.isFindBarInitialized(tab)) {
				let bar = gBrowser.getFindBar(tab);
				initFindBarRoutine(bar, name, init, force);
			}
		}
	}
};

this.initFindBarRoutine = function(bar, name, init, force) {
	if(force || !bar[objName+'_initialized'] || !bar[objName+'_initialized'][name]) {
		if(!bar[objName+'_initialized']) {
			bar[objName+'_initialized'] = { length: 0 };
		}
		init(bar);
		if(!bar[objName+'_initialized'][name]) {
			bar[objName+'_initialized'].length++;
		}
		bar[objName+'_initialized'][name] = true;
	}
};

this.deinitFindBar = function(name) {
	if(!initRoutines[name]) { return; }
	var deinit = initRoutines[name].deinit;
	delete initRoutines[name];
	
	if(FITFull || viewSource) {
		deinitFindBarRoutine(gFindBar, name, deinit);
	} else {
		for(let tab of gBrowser.tabs) {
			if(gBrowser.isFindBarInitialized(tab)) {
				let bar = gBrowser.getFindBar(tab);
				deinitFindBarRoutine(bar, name, deinit);
			}
		}
	}
};

this.deinitFindBarRoutine = function(bar, name, deinit) {
	if(bar[objName+'_initialized'] && bar[objName+'_initialized'][name]) {
		deinit(bar);
		delete bar[objName+'_initialized'][name];
		bar[objName+'_initialized'].length--;
		if(!bar[objName+'_initialized'].length) {
			delete bar[objName+'_initialized'];
		}
	}
};

this.initializeListener = function(e) {
	let bar = e.target._findBar;
	if(!bar) { return; }
	
	bar[objName+'_initialized'] = { length: 0 };
	for(let r in initRoutines) {
		initRoutines[r].init(bar);
		bar[objName+'_initialized'][r] = true;
		bar[objName+'_initialized'].length++;
	}
	
	// in case we want to recycle the state from the findbar saved on that same tab,
	// don't forget to delete the state property, otherwise we can end up with ZCs
	if(restoreFindBarState(bar, e.target._findBar_state)) {
		delete e.target._findBar_state;
	}
};

this.saveFindBarState = function(tab) {
	let bar = tab._findBar;
	
	// nothing to save if there's no findbar
	// only save the state if the findbar is opened and if it's not any of the quick modes
	if(bar && !bar.hidden && bar._findMode == bar.FIND_NORMAL) {
		tab._findBar_state = {
			value: bar._findField.value,
			highlight: bar.getElement('highlight').checked,
			caseSensitive: bar.getElement('find-case-sensitive').checked
		};
		return tab._findBar_state;
	}
	
	return tab._findBar_state || null;
};

// restores the state from saveFindBarState
this.restoreFindBarState = function(bar, state) {
	if(!state) { return false; }
	
	bar._findField.value = state.value;
	bar.getElement('highlight').checked = state.highlight;
	bar.getElement('find-case-sensitive').checked = state.caseSensitive;
	bar.open();
	
	return true;
};

// when a browser's content goes from remote to non-remote or vice-versa, its Finder will lose all its active references,
// so we destroy the findbar and recreate it to ensure everything is properly re-initialized (anything destroyed/removed is also properly deinitialized in this way),
// afterwards we recreate the find bar and apply its previous state, so that for the user it will seem like nothing actually happened to it
this.tabRemotenessChanged = function(e) {
	if(gBrowser.isFindBarInitialized(e.target)) {
		saveFindBarState(e.target);
		destroyFindBar(e.target);
		gBrowser.getFindBar(e.target);
	}
};

this.destroyFindBar = function(tab) {
	var bar = tab._findBar;
	if(!bar) { return; }
	
	bar._destroying = true;
	
	if(bar[objName+'_initialized'] && bar[objName+'_initialized'].length > 0) {
		// we have to uninitialize from last to first!
		var routines = [];
		for(let r in initRoutines) {
			routines.unshift(r);
		}
		for(let r of routines) {
			if(bar[objName+'_initialized'][r]) {
				initRoutines[r].deinit(bar);
				delete bar[objName+'_initialized'][r];
				bar[objName+'_initialized'].length--;
			}
		}
	}
	
	try {
		// not really sure if this is needed since we're physically destroying the findbar later, but making sure either way
		if(bar._browser && bar._browser.messageManager) {
			bar._browser.messageManager.sendAsyncMessage("Findbar:Disconnect");
			bar._browser.messageManager.removeMessageListener("Findbar:Keypress", bar);
			bar._browser.messageManager.removeMessageListener("Findbar:Mouseup", bar);
		}
	}
	catch(ex) {} // don't really care if this fails
	
	// also deinitialize the Finder object
	if(bar.browser.isRemoteBrowser) {
		bar.browser._remoteFinder = null;
	} else {
		bar.browser._finder = null;
	}
	
	bar.destroy();
	bar.remove();
	tab._findBar = null;
};

Modules.LOADMODULE = function() {
	if(!FITFull && !viewSource) {
		Listeners.add(gBrowser.tabContainer, "TabSelect", tabSelectBaseListener);
		tabSelectBaseListener();
		
		Listeners.add(window, 'TabFindInitialized', initializeListener);
		Listeners.add(window, 'TabRemotenessChange', tabRemotenessChanged);
	}
	
	initFindBar('gFindBar', baseInit, baseDeinit);
};

Modules.UNLOADMODULE = function() {
	deinitFindBar('gFindBar');
	
	if(!FITFull && !viewSource) {
		Listeners.remove(gBrowser.tabContainer, "TabSelect", tabSelectBaseListener);
		Listeners.remove(window, 'TabFindInitialized', initializeListener);
		Listeners.remove(window, 'TabRemotenessChange', tabRemotenessChanged);
	}
	
	/* Prevent a ZC */
	if(FITFull || viewSource) {
		delete gFindBar[objName+'_initialized'];
	} else {
		for(let tab of gBrowser.tabs) {
			if(gBrowser.isFindBarInitialized(tab)) {
				let bar = gBrowser.getFindBar(tab);
				delete bar[objName+'_initialized'];
			}
		}
	}
};
