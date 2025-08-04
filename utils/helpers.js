// utils/helpers.js

const log = (message, data) => {
    const dataString = data ? `\n${JSON.stringify(data, null, 2)}` : "";
    console.log(`[LOG] ${new Date().toISOString()} - ${message}${dataString}`);
};

const formatDateTime = (isoString) => {
    if (!isoString) return "N/A";
    const date = new Date(isoString);
    const options = {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: "2-digit", minute: "2-digit", hour12: false,
    };
    return date.toLocaleString("en-GB", options);
};

const formatTime = (isoString) => {
    if (!isoString) return "N/A";
    const date = new Date(isoString);
    const options = { hour: "2-digit", minute: "2-digit", hour12: false };
    return date.toLocaleTimeString("en-GB", options);
};

const formatDate = (isoString) => {
    if (!isoString) return "N/A";
    const date = new Date(isoString);
    const options = {
        year: '2-digit',
        month: '2-digit',
        day: '2-digit',
    };
    return date.toLocaleDateString("en-GB", options);
};

const isValidTurkishPhoneNumber = (phone) => {
    if (!phone) return { isValid: false, message: "Phone number cannot be empty." };
    const forbiddenCharsRegex = /[^\d\s+]/;
    if (forbiddenCharsRegex.test(phone)) {
        return { isValid: false, message: "Phone number contains invalid characters. Only digits, spaces, and '+' are allowed." };
    }
    if (phone.lastIndexOf('+') > 0) {
        return { isValid: false, message: "The '+' symbol can only be at the beginning of the phone number." };
    }
    const finalCleaned = phone.replace(/\D/g, '');
    const finalRegex = /^(905|05|5)([0345][0-9])\d{7}$/;
    if (!finalRegex.test(finalCleaned)) {
        return { isValid: false, message: "This does not appear to be a valid Turkish mobile number format." };
    }
    return { isValid: true, message: "Valid" };
};

const isValidWeight = (weight) => {
    if (!weight) return { isValid: false, message: "Weight cannot be empty." };
    const num = Number(weight);
    if (isNaN(num)) return { isValid: false, message: "Weight must be a number." };
    if (num <= 0) return { isValid: false, message: "Weight must be a positive number." };
    return { isValid: true, message: "Valid" };
};

const isNumericString = (value) => value && !isNaN(value);

const isFourDigitsOrLess = (value) => /^\d{1,4}$/.test(value);

const parseTemplate = (text) => {
    const data = {};
    if (!text) return data;
    const lines = text.trim().split("\n");
    for (const line of lines) {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex > 0) {
            let key = line.substring(0, separatorIndex).trim();
            key = key.replace(/\*+/g, "").replace(/\(optional\)/gi, "").trim().toLowerCase();
            const value = line.substring(separatorIndex + 1).trim();
            if (key && (value || key.includes("optional"))) {
                data[key] = value || "";
            }
        }
    }
    log("Parsed Template Data Block:", data);
    return data;
};

module.exports = {
    log,
    formatDateTime,
    formatTime,
    formatDate,
    isValidTurkishPhoneNumber,
    isValidWeight,
    isNumericString,
    isFourDigitsOrLess,
    parseTemplate,
};