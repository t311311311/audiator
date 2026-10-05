// Scratch: the real app (src/index.js) with its data in a temporary folder and
// the accounts server on a spare port, so the user's own dev data is untouched.
const { app } = require('electron');
app.setPath('userData', process.env.AUD_TEST_USERDATA);
require('C:/Test01/tray-translator/src/index.js');
