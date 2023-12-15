'use strict';

var test = require('tape');
var forEach = require('for-each');
var path = require('path');
var fs = require('fs');
var defaultCategory = require('node-exports-info/getCategory')();
var entries = require('object.entries');
var keys = require('object-keys');

var sync = require('../sync');
var async = require('../async');

var fixturesDir = path.join(__dirname, './list-exports/packages/tests/fixtures/');
var fixtures = fs.readdirSync(fixturesDir);

test('list-exports fixtures', function (t) {
    var category = 'pre-exports';

    t.test('category: ' + category + ':', function (st) {
        forEach(fixtures, function (fixture) {
            var fixtureDir = path.join(fixturesDir, fixture);
            var projectDir = path.join(fixtureDir, 'project');
            var expectedPath = path.join(fixtureDir, 'expected', defaultCategory + '.json');
            var expected = require(expectedPath);

            if (!expected.private && fixture !== 'ls-exports' && fixture !== 'list-exports') {
                var pairs = entries(expected.exports[category].require);

                var options = { basedir: projectDir, extensions: keys(require.extensions) };

                st.test(fixture + ': sync', function (s2t) {
                    forEach(pairs, function (pair) {
                        var lhs = pair[0];
                        var rhs = pair[1];

                        s2t.equal(
                            sync(lhs, options),
                            path.join(projectDir, rhs),
                            fixture + ': sync: `' + lhs + '` resolves to `' + rhs + '`'
                        );
                    });

                    s2t.end();
                });

                st.test(fixture + ': async', function (s2t) {
                    s2t.plan(2 * pairs.length);

                    forEach(pairs, function (pair) {
                        var lhs = pair[0];
                        var rhs = pair[1];

                        async(lhs, options, function (err, result) {
                            s2t.error(err, fixture + ': async: `' + lhs + '` does not error');
                            s2t.equal(
                                result,
                                path.join(projectDir, rhs),
                                fixture + ': async: `' + lhs + '` resolves to `' + rhs + '`'
                            );
                        });
                    });
                });
            }
        });

        st.end();
    });

    t.end();
});
