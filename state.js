// state.js

// userState stores the current action and data for each user mid-conversation
const userState = {};

// These will hold the data loaded from JSON files
let userDB = {};
let ordersDB = {};

module.exports = {
    userState,
    userDB,
    ordersDB,
};