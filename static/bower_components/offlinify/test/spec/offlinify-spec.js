
//var offlinify = new Offlinify();

describe('Offlinify Tests', function() {

  it('should have an objectUpdate function', function() {
    expect(Offlinify.objectUpdate).toBeDefined();
  });

  it('should have a wrapData function', function() {
    expect(Offlinify.wrapData).toBeDefined();
  });

  it('should have a subscribe function', function() {
    expect(Offlinify.subscribe).toBeDefined();
  });

  it('should not allow the exposure of internal functions', function() {
    expect(Offlinify.sync).not.toBeDefined();
  })

});
