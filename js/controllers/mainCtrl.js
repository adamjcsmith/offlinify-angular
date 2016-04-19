'use strict';

angular.module('offlineApp')
  .controller('mainCtrl', function($scope, offlineService) {

    /* Controller Model */
    $scope.dataModel = [];

    // Function declarations:
    $scope.forceRefresh = forceRefresh;
    $scope.objectUpdate = offlineService.objectUpdate;
    $scope.wipeIndexedDB = wipeIndexedDB;

    $scope.switchDataSource = switchDataSource;

    /* Controller observer-pattern function */
    var updateCtrl = function(response) {
      console.log("Data has reached the controller.");
      $scope.dataModel = offlineService.serviceDB[0].data;
      _updateToUI("Update complete, request took: " + response + "sec.");
    };

    // Register with the service:
    offlineService.subscribe(updateCtrl);

    function switchDataSource() {
      $scope.dataModel = offlineService.serviceDB[1].data;
    };

    // Force a sync cycle when a user requests it:
    function forceRefresh() {
      offlineService.sync(function(response) {
        updateCtrl(response);
      });
    };

    // For diagnostics, allow wiping of IndexedDB:
    function wipeIndexedDB() {
      offlineService.wipeIDB(function() {
        forceRefresh();
      });
    };

    function _updateToUI(text) {
      $scope.$applyAsync();
      _sendNotification(text);
    }

    function _sendNotification(text) {
      $.notify(text, {position: "bottom right", showDuration: 100, className: "success"});
    };

  });
