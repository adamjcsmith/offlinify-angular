angular.module('offline-app').controller('offlineCtrl', function($scope, offlineService) {

  $scope.dataModel = [];

  // Declare objectStores
  Offlinify.objStore("trains", "id", "timestamp", "http://offlinify.io/api/get?after=", "http://offlinify.io/api/post");

  // Then declare init to start the process
  Offlinify.init({});

  // Use the api: return data
  Offlinify.wrapData("trains", function(data) {
    $scope.dataModel = data;
    $scope.$applyAsync();
  });

});
