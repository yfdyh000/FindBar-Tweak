Modules.VERSION = '1.0.1';

Modules.LOADMODULE = function() {
	Piggyback.add('UnloadTab', window.unloadTabObj, 'tabUnload', function(aTab, params) {
		saveFindBarState(aTab);
		destroyFindBar(aTab);
		
		// we're completely replacing the method, so we need to make sure we still call the original
		this._tabUnload(aTab, params);
	});
	
	// a listener method as a property of a function... seriously?...
	window.unloadTabObj.tabUnload.resetTabAttr = window.unloadTabObj._tabUnload.resetTabAttr;
};

Modules.UNLOADMODULE = function() {
	Piggyback.revert('UnloadTab', window.unloadTabObj, 'tabUnload');
};
