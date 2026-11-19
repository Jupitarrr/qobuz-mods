'use strict';

module.exports = {
  ...require('./patch'),
  ...require('./sign'),
  ...require('./plist'),
  ...require('./install-runtime'),
};
