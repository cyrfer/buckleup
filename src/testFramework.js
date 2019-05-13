const Ajv = require('ajv');
const assert = require('chai').assert;
const got = require('got');
const sigV4 = require('sigv4');
const path = require('path');

const drillDown = require('deepdown').default;
const mocha = require('mocha');
const sinon = require('sinon');
const mocker = require('sinon-mocker');

const clone = (data) => {
    return JSON.parse(JSON.stringify(data));
};

function compile(schema) {
    const ajv = new Ajv({allErrors: true});
    return ajv.compile( schema );
};

exports.validTestFormat = compile(require('./schema-test-framework.json'));

// from: https://stackoverflow.com/questions/30003353/can-es6-template-literals-be-substituted-at-runtime-or-reused
function renderTemplate(tStr, tVars){
    return new Function("return `" + tStr + "`;").call(tVars);
}

exports.renderTemplate = renderTemplate;

const httpCall = (task, ctx) => {
    let req = {
        url: renderTemplate(task.url, ctx),
        headers: task.headers,
        method: task.httpMethod,
    };
    if (/POST/i.test(task.httpMethod)) {
        // TODO: can you `require('path.relative.to.app')` ?
        const filename = path.resolve(process.cwd(), task.body);
        req.body = JSON.stringify(require(filename));
    }
    if (task.auth === 'AWS_IAM') {
        req = sigV4(req, ctx.config);
    }
    return got(task.url, req)
        .then(response => {
            ctx[task.contextKey] = JSON.parse(response.body);
        });
}

const requireCall = (task, ctx) => {
    const filepath = path.resolve(process.cwd(), task.requirePath);
    const requireData = require(filepath);
    ctx[task.contextKey] = requireData;
};

const loadValue = (val) => {
    if (val.file) {
        const filepath = path.resolve(process.cwd(), val.file);
        const requireData = require(filepath);
        return requireData;
    }
    return val;
}

const stubCall = (task, ctx) => {
    const mod = require(task.requirePath);
    if (!ctx.mocks) {
        ctx.mocks = {};
    }
    if (!ctx.mocks[task.className]) {
        ctx.mocks[task.className] = {};
    }
    (task.methods || []).forEach(m => {
        ctx.mocks[task.className][m.name] = sinon.stub();
        (m.calls || [m]).forEach((c, i) => {
            const loadedValue = loadValue(c.value);
            const sinonCall = ctx.mocks[task.className][m.name].onCall(i);
            c.spread ? sinonCall[c.stubMethod](...loadedValue) : sinonCall[c.stubMethod](loadedValue);
        });
    });

    if (!ctx.stubs) {
        ctx.stubs = {};
    }
    if (!ctx.stubs[task.className]) {
        ctx.stubs[task.className] = sinon.stub(mod, task.className).callsFake(mocker.fakeCtor(ctx.mocks[task.className]));
    }
}

const taskFactories = {
    http: httpCall,
    require: requireCall,
    stub: stubCall,
}

exports.setup = (context, tasks) => {
    return Promise.all((tasks || []).map(task => {
        return taskFactories[task.taskType](task, context)
    }))
        .then(() => {
            return context;
            // return [null, context];
        })
        // .catch(e => {
        //     return [e, context];
        // })
}

// TODO: implement if needed
exports.teardown = async (config, tasks) => {
    // return [null, null];
    return config;
}

exports.doCompare = (expectedData, data) => ({compareKey, parse, omitKeys, operator}) => {
    function fnOmit(accum, omitKey) {
        const keyPath = omitKey.split('.');
        const nextToLastPath = keyPath.slice(0, -1);
        const lastPath = keyPath.slice(-1);
        if (keyPath.length === 1 || drillDown(accum, nextToLastPath)) {
            delete drillDown(accum, nextToLastPath)[lastPath];
        }
        return accum;
    }

    if (parse) {
        expectedData[compareKey] = JSON.parse(expectedData[compareKey]);
        data[compareKey] = JSON.parse(data[compareKey]);
    }

    expectedData = (omitKeys || []).reduce(fnOmit, expectedData);
    data = (omitKeys || []).reduce(fnOmit, data);

    const drillKeys = compareKey.split('.');
    const resData = drillDown(data, drillKeys);
    const expData = drillDown(expectedData, drillKeys);
    if (operator === 'match') {
        assert[operator](resData, new RegExp(expData), `compare failed for key [${compareKey}]`);
    } else {
        assert[operator](resData, expData, `compare failed for key [${compareKey}]`);
    }
}

// TODO: figure out how to leverage `appError`
exports.runAsserts = (/*appError,*/ appData, expectedOutputData, testAsserts) => {
    // assert.isNotOk(appError, `application error: ${JSON.stringify(appError)}`);
    testAsserts.forEach(exports.doCompare(expectedOutputData, appData))
}

exports.wrapPromise = async (app, test, setupContext) => {
    let inputs;
    if (test.input) {
        if (test.input.file) {
            const filepath = path.resolve(process.cwd(), test.input.file);
            inputs = require(filepath);
        } else {
            inputs = test.input.value;
        }
    }
    return (test.input && test.input.spread) ? app(...inputs) : app(inputs);
}

const utilCallback = (resolve, reject, test) => (err, data) => {
    if (err) {
        return reject(err);
    }
    resolve([null, data]);
};

exports.wrapCallback = async (app, test, setupContext) => {
    let inputs;
    if (test.input) {
        if (test.input.file) {
            const filepath = path.resolve(process.cwd(), test.input.file);
            inputs = require(filepath);
        } else {
            inputs = test.input.value;
        }
    }
    return new Promise((resolve, reject) => {
        (test.input && test.input.spread) ? app(...inputs, utilCallback(resolve, reject, test)) : app(inputs, utilCallback(resolve, reject, test));
    })
}

const loadApplicationModule = (allTests) => {
    let mod = allTests.module;
    if (typeof allTests.module === 'string') {
        const filepath = path.resolve(process.cwd(), allTests.module);
        mod = require(filepath);
    }
    if (mod && typeof allTests.moduleKey === 'string') {
        return mod[allTests.moduleKey];
    }
    return mod;
};

const loadExpectation = (test) => {
    const expectation = test.expectedError || test.expectedOutput;
    if (expectation.file) {
        const filename = path.resolve(process.cwd(), expectation && expectation.file || '');
        expectation.value = require(filename);
    }
    return expectation;
};

const testLifecycle = (app, test, testContext, testWrapper) => async () => {
    // setup preconditions for testing
    // OPTIONAL: alternatively setup `serviceStubs`
    // TODO: auth needed creds that were in `lambda.runtime`
    const useMocks = drillDown(testContext, 'config.useMocks'.split('.'));
    const setupContext = await exports.setup(testContext, useMocks ? test.serviceStubs: test.setupCalls);
    // const [setupError, setupContext] = await exports.setup(testContext, testContext.useMocks ? test.serviceStubs: test.setupCalls);
    // assert.isNotOk(setupError, `setup error: ${JSON.stringify(setupError)}`);

    // call app code
    let appData, appError;
    try {
        appData = await testWrapper(app, test, setupContext);
    } catch (e) {
        if (test.expectedError) {
            appError = e;
            // TODO: runAssets for expected error?
        } else {
            throw e;
        }
    }

    // check asserts
    const expectations = loadExpectation(test);
    expectations && exports.runAsserts(test.expectedError ? appError : appData, expectations.value || expectations, expectations.asserts);

    // do any cleanup calls
    // const [teardownError, teardownData] = await exports.teardown(testContext, test.teardownCalls);
    // return teardownError // not sure what is best to return here
    const teardownContext = await exports.teardown(testContext, test.teardownCalls);
    return teardownContext;
};

exports.makeTests = (allTests, seedContext={}, testWrapper=exports.wrapPromise, {describe, it}=mocha) => {
    if (!allTests) {
        throw new Error(`missing tests: ${allTests}`);
    }
    if (typeof allTests === 'string') {
        const filepath = path.resolve(process.cwd(), allTests);
        allTests = require(filepath);
    }
    const nameOfSuite = seedContext.nameOfTestSuite ? seedContext.nameOfTestSuite : (seedContext.useMocks ? 'unit' : 'integration');
    describe(nameOfSuite, () => {
        if (!exports.validTestFormat(allTests)) {
            throw new Error(`invalid test format: ${JSON.stringify(exports.validTestFormat.errors)}`);
        }

        const app = loadApplicationModule(allTests);

        // prepare to run each test
        (allTests.tests || []).forEach((test, testIndex) => {
            describe(`test: ${testIndex}`, () => {
                const testContext = {config: clone(seedContext)};
                (test.only ? it.only : (test.skip ? it.skip : it))(test.name, testLifecycle(app, test, testContext, testWrapper));
                after(() => {
                    testContext.mocks && mocker.resetMocks(testContext.mocks);
                    testContext.stubs && mocker.restoreServices(testContext.stubs);
                })
            })
        })
    });
}