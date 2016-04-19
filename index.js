var http = require('http');
var express = require('express');
var app = express();
var jade = require('pug');

app.set('views', './views');
app.set('view engine', 'pug');

app.get('/', function(req, res) {
  res.render('index');
});

app.listen(80, function() {
  console.log("offlinify-angular now running");
});
