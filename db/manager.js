// db/manager.js
const fs = require("fs");
const { log } = require("../utils/helpers");
let { userDB, ordersDB } = require("../state");

const loadDatabases = () => {
    try {
        if (fs.existsSync("db.json")) {
            log("Loading user database from db.json...");
            const data = fs.readFileSync("db.json", "utf8");
            if (data) Object.assign(userDB, JSON.parse(data));
        }
        if (fs.existsSync("orders.json")) {
            log("Loading orders database from orders.json...");
            const data = fs.readFileSync("orders.json", "utf8");
            if (data) Object.assign(ordersDB, JSON.parse(data));
        }
    } catch (err) {
        console.error("Error loading database files:", err);
    }
};

const saveUserDB = () => {
    try {
        fs.writeFileSync("db.json", JSON.stringify(userDB, null, 2), "utf8");
        log("User database saved successfully.");
    } catch (err) {
        console.error("Error writing to db.json:", err);
    }
};

const saveOrder = (chatId, order) => {
    try {
        const orderId = new Date().toISOString();
        if (!ordersDB[chatId]) {
            ordersDB[chatId] = [];
        }
        ordersDB[chatId].push({ orderId, order });
        fs.writeFileSync(
            "orders.json",
            JSON.stringify(ordersDB, null, 2),
            "utf8",
        );
        log("New order saved successfully.", { chatId, orderId });
    } catch (err) {
        console.error("Error writing to orders.json:", err);
    }
};

module.exports = {
    loadDatabases,
    saveUserDB,
    saveOrder,
};