"use strict";

angular.module('offline-app').service('offlineService', ['$http', function(http) {

  var testFunction = function() {
    console.log("Callback function called.");
  }

  Offlinify.subscribe(testFunction);

}]);
