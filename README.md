# buckleup
A framework for data driven tests.

# install
`npm i -D buckleup`

# usage
Implement your Mocha.js tests with a single Javascript file, pointing buckleup to your test file.

```
const buckleup = require('buckleup');

buckleup.makeTests('./test/module-tests.json');
```
