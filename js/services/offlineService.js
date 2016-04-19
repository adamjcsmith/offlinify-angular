'use strict';

angular.module('offlineApp').service('offlineService', function($http) {

    var view_model = this;

    /* --------------- Configuration --------------- */

    // Multistore:
    view_model.serviceDB = [
      {
          "name": "cars",
          "primaryKeyProperty": "id",
          "timestampProperty": "timestamp",
          "readURL": "http://offlinify.io/api/get?after=",
          "updateURL": "http://offlinify.io/api/post",
          "createURL": "http://offlinify.io/api/post",
          "data": []
      }, /*
       {
          "name": "planes",
          "primaryKeyProperty": "id",
          "timestampProperty": "timestamp",
          "readURL": "http://188.166.147.80/getBig?after=",
          "updateURL": "http://188.166.147.80/post",
          "createURL": "http://188.166.147.80/post",
          "data": []
      } */
    ];

    // Default Config:
    view_model.autoSync = 0; /* Set to zero for no auto synchronisation */
    view_model.pushSync = true;
    view_model.initialSync = true;
    view_model.allowIndexedDB = true; /* Switching to false disables IndexedDB */
    view_model.allowRemote = true;

    // Error Config (Response Codes):
    view_model.retryOnResponseCodes = [0,401,500,502]; /* Keep item (optimistically) on queue */
    view_model.replaceOnResponseCodes = [400,403,404]; /* Delete item from queue, try to replace */
    view_model.maxRetry = 3; /* Try synchronising retry operations this many times */

    // IndexedDB Config:
    view_model.indexedDBDatabaseName = "offlinifyDB-1";
    view_model.indexedDBVersionNumber = 3; /* Increment this to wipe and reset IndexedDB */
    view_model.objectStoreName = "testObjectStore";

    /* --------------- Offlinify Internals --------------- */

    // Service Variables
    view_model.idb = null;
    view_model.observerCallbacks = [];
    view_model.lastChecked = new Date("1970-01-01T00:00:00.000Z").toISOString(); /* Initially the epoch */

    // Public Functions
    view_model.subscribe = subscribe;
    view_model.sync = sync;
    view_model.objectUpdate = objectUpdate;
    view_model.wipeIDB = wipeIDB;
    view_model.wrapData = wrapData;

    // Asynchronous handling
    view_model.syncInProgress = false;
    view_model.callbackWhenSyncFinished = [];

    // Determine IndexedDB Support
    view_model.indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB || window.shimIndexedDB;
    if(!view_model.allowIndexedDB) view_model.indexedDB = null;

    /* --------------- Create/Update and Retrieve --------------- */

    // Filters create or update ops by queue state:
    function objectUpdate(obj, store, successCallback, errorCallback) {
      if(_getObjStore(store) === undefined) return;
      _.set(obj, _getObjStore(store).timestampProperty, _generateTimestamp());
      if(obj.hasOwnProperty("syncState")) {
        if(obj.syncState > 0) { obj.syncState = 2; }
      } else {
        obj = _.cloneDeep(obj);
        obj.syncState = 0;
        _.set(obj, _getObjStore(store).primaryKeyProperty, _generateUUID());
      }
      obj.successCallback = successCallback;
      obj.errorCallback = errorCallback;
      _patchLocal([obj], store, function(response) {
        if(view_model.pushSync) sync(_notifyObservers);
      });
    };

    // Wraps up the data and queues the callback when required:
    function wrapData(store, callback) {
      console.log("Wrap data called");
      if(_getObjStore(store) === undefined) return {};

      var deferredFunction = function() {
        var originalWrapper = _getObjStore(store).originalWrapper;
        var currentData = _getObjStore(store).data;
        _.set(originalWrapper, _getObjStore(store).dataPrefix, currentData);
        callback(originalWrapper);
      }

      if(view_model.syncInProgress) {
        view_model.callbackWhenSyncFinished.push({"callback": deferredFunction});
      } else {
        deferredFunction(); // call immediately.
      }

    };

    /* --------------- Observer Pattern --------------- */

     // Called by a controller to be notified of data changes:
    function subscribe(ctrlCallback) {
       _establishIDB(function() {
         view_model.observerCallbacks.push(ctrlCallback);
         if(!view_model.initialSync) return;
         view_model.sync(function(response) {
           ctrlCallback(response);
         });
       });
     };

    function _notifyObservers(status) {
      angular.forEach(view_model.observerCallbacks, function(callback){
        callback(status);
      });
    };

    /* --------------- Synchronisation --------------- */

    // Restores local state on first sync, or patches local and remote changes:
    function sync(callback) {
      console.log("Sync started.");
      view_model.syncInProgress = true;
      var startClock = _generateTimestamp();
      var newLocalRecords = _getLocalRecords(view_model.lastChecked);
      if( newLocalRecords.length == 0 && checkServiceDBEmpty() ) {
        _restoreLocalState( function(localResponse) {
          callback((new Date(_generateTimestamp()) - new Date(startClock))/1000); // Load IDB records straight into DOM first.
          mergeEditsReduceQueue(startClock, callback);
        });
      } else {
        mergeEditsReduceQueue(startClock, callback);
      }
    };

    function mergeEditsReduceQueue(startTime, callback) {
      _patchRemoteChanges(function(remoteResponse) {
        _reduceQueue(function(queueResponse) {
          callback((new Date(_generateTimestamp()) - new Date(startTime))/1000);
          syncFinished();
        });
      });
    };

    function syncFinished() {
      console.log("Sync finished.");
      // Call each of the callbacks in turn.
      // Set view_model.syncInProgress back to false!
      console.log("callback queue length was: " + view_model.callbackWhenSyncFinished.length);
      _.forEach(view_model.callbackWhenSyncFinished, function(item) {
        item.callback(); // experimental
      });
      view_model.callbackWhenSyncFinished = [];
      view_model.syncInProgress = false;
    };

    // Patches remote edits to serviceDB + IndexedDB:
    function _patchRemoteChanges(callback) {

      // Reject request if remote is disabled:
      if(!view_model.allowRemote) {
          if(_IDBSupported()) callback(-1);
          else callback(-1);
          return;
      }

      // If there's no data models end request:
      if(view_model.serviceDB.length == 0) { callback(-1); return; }

      var counter = 0;

      function doFunction() {
        if(view_model.serviceDB.length == counter) {
          view_model.lastChecked = _generateTimestamp();
          callback(1);
          return;
        }

        _getRemoteRecords(view_model.serviceDB[counter].name, function(response) {
          if(response.status == 200) {
            _patchLocal(response.data, view_model.serviceDB[counter].name, function(localResponse) {
              counter++;
              doFunction();
            });
          } else {
            counter++;
            doFunction();
           }
        });
      };
      doFunction();
    };

    // Patches the local storages with a dataset.
    function _patchLocal(data, store, callback) {
      _patchServiceDB(data, store);
      if( _IDBSupported() ) {
        _replaceIDBStore(store, function() {
          callback(1); // Patched to IDB + ServiceDB
        });
      } else {
        callback(0); // Patched to ServiceDB only.
      }
    };

    /* --------------- Queue + State --------------- */

    // Puts IndexedDB store into scope:
    function _restoreLocalState(callback) {
      if(!_IDBSupported()) { callback(-1); return; }
      _getIDB(function(idbRecords) {

        // Collect the entire queue (?)
        var allElements = [];

        // For each first level (object store) element:
        for(var i=0; i<idbRecords.length; i++) {

          // Sort by newest date:
          console.log("Attempting to get: " + idbRecords[i].name);
          var sortedElements = _.reverse(_.sortBy(idbRecords[i].data, function(o) {
            return new Date(_.get(o, idbRecords[i].timestampProperty)).toISOString();
          }));

          // Divide into queue/non-queue elements:
          var nonQueueElements = _.filter(idbRecords[i].data, {syncState: 1});
          var queueElements = _.filter(idbRecords[i].data, function(o) { return o.syncState != 1; });

          // Update lastChecked:
          if(nonQueueElements.length > 0) {
            var recentSyncTime = _.get(sortedElements[0], idbRecords[i].timestampProperty);
            if(recentSyncTime > view_model.lastChecked) view_model.lastChecked = recentSyncTime;

          } else {
            if(queueElements.length > 0) {
              var recentSyncTime = _.get(queueElements[queueElements.length - 1], idbRecords[i].timestampProperty);
              if(recentSyncTime > view_model.lastChecked) view_model.lastChecked = recentSyncTime;
            }
          }

        }

        if(idbRecords.length > 0) view_model.serviceDB = idbRecords;

        callback(1);
      });
    };

    // Synchronises elements to remote when connection is available:
    function _reduceQueue(callback) {
      if(!view_model.allowRemote) { callback(-1); return; }

      var counter = 0;

      function reduceObjectStore() {

        // If queue is empty then return:
        if(counter == view_model.serviceDB.length) { callback(1); return; }

        // Sort into create and update queues:
        var createQueue = _.filter(view_model.serviceDB[counter].data, { "syncState" : 0 });
        var updateQueue = _.filter(view_model.serviceDB[counter].data, { "syncState" : 2 });

        // Reduce the queue:
        _safeArrayPost(createQueue, view_model.serviceDB[counter].createURL, function(createResponse) {
          _safeArrayPost(updateQueue, view_model.serviceDB[counter].updateURL, function(updateResponse) {

            var itemsToPatch = [];

            // Items to retry later:
            var retryCreates = createResponse.toRetry;
            var retryUpdates = updateResponse.toRetry;
            var itemsToRetry = retryCreates.concat(retryUpdates);
            var retryProcessed = _retryQueue(itemsToRetry);
            itemsToPatch = itemsToPatch.concat(retryProcessed.survived);

            // Items to pop from the queue:
            var popCreates = createResponse.toPop;
            var popUpdates = updateResponse.toPop;
            var itemsToPop = popCreates.concat(popUpdates);
            _.forEach(itemsToPop, function(value) {
              _.set(value, view_model.serviceDB[counter].timestampProperty, _generateTimestamp());
            });
            itemsToPatch = itemsToPatch.concat(_resetSyncState(itemsToPop));

            // Items to replace now:
            var replaceCreates = createResponse.toReplace;
            var replaceUpdates = updateResponse.toReplace;
            var itemsToReplace = replaceCreates.concat(replaceUpdates);
            itemsToReplace = itemsToReplace.concat(retryProcessed.toReplace);
            _.forEach(retryProcessed.toReplace, function(value) {
              if(value.errorCallback) value.errorCallback(0);
            });
            itemsToPatch = itemsToPatch.concat(_replaceQueue(view_model.serviceDB[counter].name, itemsToReplace));

            _patchLocal(itemsToPatch, view_model.serviceDB[counter].name, function(response) {
              counter++;
              reduceObjectStore();
            });

          });
        });

      }

      reduceObjectStore();
    };

    function _retryQueue(elementsToRetry) {
      var survived = [];
      var toReplace = [];
      _.forEach(elementsToRetry, function(item) {

        // Set or increment a try:
        if(item.syncAttempts === undefined) item.syncAttempts = 1;
        else item.syncAttempts = item.syncAttempts + 1;

        // Deal with items that have too many tries:
        if(item.syncAttempts > view_model.maxRetry) toReplace.push(item);
        else survived.push(item);

      });
      return({"survived": survived, "toReplace": toReplace});
    };

    function _replaceQueue(store, elementsToReplace) {
      var counter = 0;
      var timestampProp = _getObjStore(store).timestampProperty;

      // Set each element to the epoch to force it to be replaced:
      _.forEach(elementsToReplace, function(item) {
        _.set(item, timestampProp, "1971-01-01T00:00:00.000Z");
      });

      return elementsToReplace;
    };

    /* --------------- ServiceDB Interface --------------- */

    function checkServiceDBEmpty() {
      var totalRecords = [];
      for(var i=0; i<view_model.serviceDB.length; i++) {
        totalRecords = totalRecords.concat(view_model.serviceDB[i].data);
      }
      if(totalRecords.length == 0) return true;
      else return false;
    };

    function _getObjStore(name) {
      return _.find( view_model.serviceDB, {"name": name} );
    };

    function _patchServiceDB(data, store) {
      var operations = _filterOperations(data, store);
      _updatesToServiceDB(operations.updateOperations, store);
      _pushToServiceDB(operations.createOperations, store);
    };

    function _pushToServiceDB(array, store) {
      for(var i=0; i<array.length; i++) _getObjStore(store).data.push(array[i]);
    };

    function _updatesToServiceDB(array, store) {
      for(var i=0; i<array.length; i++) {
        var indexJSON = {};
        _.set(indexJSON, _getObjStore(store).primaryKeyProperty, _.get(array[i], _getObjStore(store).primaryKeyProperty));
        var matchID = _.findIndex(_getObjStore(store).data, indexJSON);
        if(matchID > -1) _getObjStore(store).data[matchID] = array[i];
      }
    };

    function _getLocalRecords(sinceTime) {
      var totalRecords = [];
      for(var i=0; i<view_model.serviceDB.length; i++) {
        totalRecords = totalRecords.concat( _.filter(view_model.serviceDB[i].data, function(o) {
          return new Date(_.get(o, view_model.serviceDB[i].timestampProperty)).toISOString() > sinceTime;
        }));
      }
      return totalRecords;
    };

    /* --------------- Data Handling --------------- */

    /* Filter remote data into create or update operations */
    function _filterOperations(data, store) {
      var updateOps = [];
      var createOps = [];
      for(var i=0; i<data.length; i++) {
        var queryJSON = {};
        _.set(queryJSON, _getObjStore(store).primaryKeyProperty, _.get(data[i], _getObjStore(store).primaryKeyProperty));
        var query = _.findIndex(_getObjStore(store).data, queryJSON);
        if( query > -1 ) updateOps.push(data[i]);
        else createOps.push(data[i]);
      }
      return { updateOperations: updateOps, createOperations: createOps };
    }

    function _resetSyncState(records) {
      for(var i=0; i<records.length; i++) {
        records[i].syncState = 1;
      }
      return records;
    };

    /* --------------- Remote --------------- */

    function _postRemote(data, url, callback) {
      $http({
          url: url,
          method: "POST",
          data: [data],
          headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
      })
      .then(
        function successCallback(response) {
          callback(response); // return response code.
        }, function errorCallback(response) {
          callback(response);
        });
    };

    function _getRemoteRecords(store, callback) {
      $http({
          method: 'GET',
          url: _getObjStore(store).readURL + view_model.lastChecked
        })
        .then(
          function successCallback(response) {

            if(response.data != [] ) {

              // If the data is prefixed, get from the prefix instead:
              if(_getObjStore(store).dataPrefix !== undefined) {
                var unwrappedData = _unwrapData(response.data, store);
                callback({data: _resetSyncState(unwrappedData), status: 200});
              } else {
                callback({data: _resetSyncState(response.data), status: 200});
              }
            }
            else {
              callback({data: [], status: 200});
            }

        }, function errorCallback(response) {
            callback({data: [], status: response.status});
        });
    };

    // Tries to post an array one-by-one; returns successful elements.
    function _safeArrayPost(array, url, callback) {
      var x = 0;
      var toPop = [];
      var toRetry = [];
      var toReplace = [];
      var noChange = [];

      if(array.length == 0) { callback({"toPop": [], "toRetry": [], "toReplace": [], "noChange": []}); return; }
      function loopArray(array) {
        _postRemote(array[x],url,function(response) {

          if(response.status == 200) {
            toPop.push(array[x]);
            if(array[x].successCallback) array[x].successCallback();
          } else if(response.status == 0) {
            noChange.push(array[x]);
          } else {
            if(_.find(view_model.retryOnResponseCodes, response.status) !== undefined) {
              toRetry.push(array[x]);
            } else if(_.find(view_model.replaceOnResponseCodes, response.status) !== undefined) {
              toReplace.push(array[x]);
              if(array[x].errorCallback) array[x].errorCallback(response); // Return entire response
            } else {
              toRetry.push(array[x]); // for now, retry on unknown code.
            }
          }

          x++;
          if(x < array.length) { loopArray(array); }
          else {
            callback({"toPop": toPop, "toRetry": toRetry, "toReplace": toReplace, "noChange": noChange}); }
        });
      };
      loopArray(array);
    };

    /* --------------- IndexedDB --------------- */

    function _IDBSupported() {
      return !( view_model.indexedDB === undefined || view_model.indexedDB === null );
    };

    function _establishIDB(callback) {
      // End request if IDB is already set-up or is not supported:
      if(!_IDBSupported() || view_model.idb) { callback(); return; }
      var request = view_model.indexedDB.open(view_model.indexedDBDatabaseName, view_model.indexedDBVersionNumber);
      request.onupgradeneeded = function(e) {
        var db = e.target.result;
        e.target.transaction.onerror = function() { console.error(this.error); };
        if(db.objectStoreNames.contains(view_model.objectStoreName)) {
          db.deleteObjectStore(view_model.objectStoreName);
        }
        var offlineItems = db.createObjectStore(view_model.objectStoreName, { keyPath: "name", autoIncrement: false } );
        //var dateIndex = offlineItems.createIndex("byDate", view_model.timestampProperty, {unique: false});
        view_model.idb = db;
      };
      request.onsuccess = function(e) {
        view_model.idb = e.target.result;
        callback();
      };
      request.onerror = function() { console.error(this.error); };
    };

    // Get the entire IndexedDB image:
    function _getIDB(callback) {
      var transaction = _newIDBTransaction();
      var objStore = transaction.objectStore(view_model.objectStoreName);
      var keyRange = IDBKeyRange.lowerBound(0);
      //var cursorRequest = objStore.index('byDate').openCursor(keyRange);
      var cursorRequest = objStore.openCursor(keyRange);
      var returnableItems = [];
      transaction.oncomplete = function(e) {
        callback(_bulkStripHashKeys(returnableItems));
      };
      cursorRequest.onsuccess = function(e) {
        var result = e.target.result;
        if (!!result == false) { return; }
        returnableItems.push(result.value);
        result.continue();
      };
      cursorRequest.onerror = function() { console.error("error"); };
    };

    // Replaces an older IDB store with a new local one:
    function _replaceIDBStore(store, callback) {
      // Reject request if no store by that name exists:
      if(_getObjStore(store) === undefined) { callback(); return; }

      // Strip angular hash keys:
      _bulkStripHashKeys(_getObjStore(store).data);

      var objStore = _newIDBTransaction().objectStore(view_model.objectStoreName);
      objStore.put(_getObjStore(store)).onsuccess = function() {
        callback();
        return;
      }
    };

    function _newIDBTransaction() {
      return view_model.idb.transaction([view_model.objectStoreName], 'readwrite');
    };

    function wipeIDB(callback) {
      var req = view_model.indexedDB.deleteDatabase(view_model.indexedDBDatabaseName);
      req.onsuccess = function(event) { callback(); }
    };

    /* --------------- Utilities --------------- */

    function _unwrapData(data, store) {
      // First get the objStore:
      var objStore = _getObjStore(store);

      // Then get the nested data:
      var nestedData = _.get(data, _getObjStore(store).dataPrefix);

      // Then get the wrapper:
      objStore.originalWrapper = data;

      // Delete the data payload from the wrapper:
      _.set(objStore.originalWrapper, objStore.dataPrefix, []);
      return nestedData;
    };

    function _generateTimestamp() {
      var d = new Date();
      return d.toISOString();
    };

    // (v4) With thanks to http://stackoverflow.com/a/8809472/3381433
    function _generateUUID() {
      var d = new Date().getTime();
      if(window.performance && typeof window.performance.now === "function"){
          d += performance.now(); // use high-precision timer if available
      }
      var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          var r = (d + Math.random()*16)%16 | 0;
          d = Math.floor(d/16);
          return (c=='x' ? r : (r&0x3|0x8)).toString(16);
      });
      return uuid;
    };

    function _bulkStripHashKeys(array) {
      for(var i=0; i<array.length; i++) {
        delete array[i].$$hashKey;
      }
      return array;
    }

    /* --------------- Sync Loop -------------- */

    if(view_model.autoSync > 0 && parseInt(view_model.autoSync) === view_model.autoSync) {
      (function syncLoop() {
        setTimeout(function() {
          sync(function(response) {
            _notifyObservers(response);
          });
          syncLoop();
        }, view_model.autoSync);
      })();
    }


  });
