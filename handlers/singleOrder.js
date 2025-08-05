// handlers/singleOrder.js
const axios = require("axios");
const bot = require("../bot");
const { userState, userDB } = require("../state");
const { saveOrder } = require("../db/manager");
const ocrService = require("../services/ocrService");
const {
    log,
    isValidTurkishPhoneNumber,
    isValidWeight,
    isFourDigitsOrLess,
    isNumericString,
    parseTemplate,
    formatDateTime,
    formatTime,
    formatDate,
} = require("../utils/helpers");

const promptForSingleOrderMode = (chatId) => {
    userState[chatId].action = "awaiting_button_press";
    bot.sendMessage(
        chatId,
        "How would you like to provide the order details?",
        {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: "Step-by-Step (Guided)",
                            callback_data: "order_mode_stepwise",
                        },
                    ],
                    [
                        {
                            text: "All at Once (Template)",
                            callback_data: "order_mode_bulk",
                        },
                    ],
                    [
                        {
                            text: "Import from Picture (OCR)",
                            callback_data: "order_mode_picture",
                        },
                    ],
                ],
                remove_keyboard: true,
            },
        },
    );
};

const startSingleOrder_Picture = (chatId) => {
    log(`Starting new SINGLE order (Picture) for user ${chatId}`);
    userState[chatId] = {
        action: "awaiting_single_order_photo",
        orderType: "single",
        history: ["start_picture"],
        order: {
            isDraft: false,
            pickupAddress: {},
            dropAddress: {},
            parcel: {},
        },
    };
    bot.sendMessage(chatId, "Please send a picture containing all the order details (pickup, drop-off, and parcel information).");
};

const validateSingleOrderData = (order) => {
    const errors = [];
    if (!order.pickupAddress.fullName || order.pickupAddress.fullName.trim() === "") errors.push("Pickup Details: 'Sender Name' is a required field.");
    if (!isValidTurkishPhoneNumber(order.pickupAddress.phoneNumber).isValid) errors.push(`Pickup Details: ${isValidTurkishPhoneNumber(order.pickupAddress.phoneNumber).message}`);
    if (!order.pickupAddress.fullAddress || order.pickupAddress.fullAddress.trim() === "") errors.push("Pickup Details: 'Full Address' is required.");
    if (!order.pickupAddress.buildingNo || !isFourDigitsOrLess(order.pickupAddress.buildingNo)) errors.push("Pickup Details: 'Building No' must be a number with 4 digits or less.");
    if (!order.pickupAddress.floor || !isFourDigitsOrLess(order.pickupAddress.floor)) errors.push("Pickup Details: 'Floor' must be a number with 4 digits or less.");
    if (!order.pickupAddress.unit || !isFourDigitsOrLess(order.pickupAddress.unit)) errors.push("Pickup Details: 'Unit' must be a number with 4 digits or less.");
    if (order.pickupAddress.postalCode && order.pickupAddress.postalCode.trim() !== "" && !isNumericString(order.pickupAddress.postalCode)) errors.push("Pickup Details: 'Postal Code' must only contain numbers.");
    if (!order.dropAddress.fullName || order.dropAddress.fullName.trim() === "") errors.push("Drop-off Details: 'Recipient Name' is required.");
    if (!isValidTurkishPhoneNumber(order.dropAddress.phoneNumber).isValid) errors.push(`Drop-off Details: ${isValidTurkishPhoneNumber(order.dropAddress.phoneNumber).message}`);
    if (!order.dropAddress.fullAddress || order.dropAddress.fullAddress.trim() === "") errors.push("Drop-off Details: 'Full Address' is required.");
    if (!order.dropAddress.buildingNo || !isFourDigitsOrLess(order.dropAddress.buildingNo)) errors.push("Drop-off Details: 'Building No' must be a number with 4 digits or less.");
    if (!order.dropAddress.floor || !isFourDigitsOrLess(order.dropAddress.floor)) errors.push("Drop-off Details: 'Floor' must be a number with 4 digits or less.");
    if (!order.dropAddress.unit || !isFourDigitsOrLess(order.dropAddress.unit)) errors.push("Drop-off Details: 'Unit' must be a number with 4 digits or less.");
    if (order.dropAddress.postalCode && order.dropAddress.postalCode.trim() !== "" && !isNumericString(order.dropAddress.postalCode)) errors.push("Drop-off Details: 'Postal Code' must only contain numbers.");
    if (!isValidWeight(order.parcel.weight).isValid) errors.push(`Parcel Details: ${isValidWeight(order.parcel.weight).message}`);
    if (order.parcel.value && order.parcel.value.trim() !== "" && !isNumericString(order.parcel.value)) errors.push("Parcel Details: 'Value' must be a valid number.");
    return errors;
};

const processSinglePicture = async (chatId, msg) => {
    const state = userState[chatId];
    if (!state) return;

    try {
        await bot.sendMessage(chatId, "Analyzing image... This may take a moment. 🧠");
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const fileLink = await bot.getFileLink(fileId);
        const response = await axios.get(fileLink, { responseType: "arraybuffer" });
        const imageBuffer = Buffer.from(response.data, "binary");

        const prompt = `
            Extract order details from the image. The user can provide the fields in any order.
            Focus on these key fields:
            - senderName
            - senderPhone
            - senderFullAddress
            - senderBuildingNo
            - senderFloor
            - senderUnit
            - recipientName
            - recipientPhone
            - recipientFullAddress
            - recipientBuildingNo
            - recipientFloor
            - recipientUnit
            - parcelWeight
            - parcelValue (optional)
            - senderPostalCode (optional)
            - senderNote (optional)
            - recipientPostalCode (optional)
            - recipientNote (optional)
            Return a single JSON object. If a field isn't found, its value must be an empty string.
        `;

        const result = await ocrService.extractDataFromImage(imageBuffer, prompt);

        if (!result.success) {
            throw new Error(result.error);
        }

        const data = result.data;
        log("Extracted data from image for single order:", data);

        const { order } = state;
        order.pickupAddress = {
            fullName: data.senderName || "",
            phoneNumber: data.senderPhone || "",
            fullAddress: data.senderFullAddress || "",
            buildingNo: data.senderBuildingNo || "",
            floor: data.senderFloor || "",
            unit: data.senderUnit || "",
            postalCode: data.senderPostalCode || "",
            note: data.senderNote || "",
        };
        order.dropAddress = {
            fullName: data.recipientName || "",
            phoneNumber: data.recipientPhone || "",
            fullAddress: data.recipientFullAddress || "",
            buildingNo: data.recipientBuildingNo || "",
            floor: data.recipientFloor || "",
            unit: data.recipientUnit || "",
            postalCode: data.recipientPostalCode || "",
            note: data.recipientNote || "",
        };
        order.parcel = {
            weight: data.parcelWeight || "",
            value: data.parcelValue || "",
        };

        const errors = validateSingleOrderData(order);

        if (errors.length > 0) {
            log("Single picture input validation failed", { errors });
            let errorMessage = "I read the image, but some information is missing or invalid:\n";
            errorMessage += `- ${errors.join("\n- ")}\n\n`;
            if (errors.length <= 3) {
                errorMessage += "You can reply with the corrected information in a message (e.g., 'senderPhone: 05...'), or send a new picture.";
                state.action = "awaiting_single_order_correction"; // New state to handle text correction
            } else {
                errorMessage += "Please try a clearer picture, or /start over to enter the details manually.";
            }
            await bot.sendMessage(chatId, errorMessage);
            return;
        }

        log("Single picture input parsed and validated successfully", { order });
        await bot.sendMessage(chatId, "✅ I've successfully extracted and validated the order details from your picture!");
        promptForSinglePickupLocation(chatId);

    } catch (error) {
        log("Error processing single order picture", { error: error.message });
        await bot.sendMessage(chatId, `❌ I encountered an error trying to read the image: ${error.message}. Please try another picture or enter the details manually.`);
    }
};

const processSingleOrderCorrection = async (chatId, text) => {
    const state = userState[chatId];
    if (!state || !state.order) return;

    log("Processing correction for single order", { text });
    // Simple key-value pair parsing
    const corrections = parseTemplate(text);
    const { order } = state;

    // Update the order object with corrections
    // This is a bit manual but necessary
    if (corrections.sendername) order.pickupAddress.fullName = corrections.sendername;
    if (corrections.senderphone) order.pickupAddress.phoneNumber = corrections.senderphone;
    if (corrections.senderfulladdress) order.pickupAddress.fullAddress = corrections.senderfulladdress;
    if (corrections.senderbuildingno) order.pickupAddress.buildingNo = corrections.senderbuildingno;
    if (corrections.senderfloor) order.pickupAddress.floor = corrections.senderfloor;
    if (corrections.senderunit) order.pickupAddress.unit = corrections.senderunit;
    if (corrections.recipientname) order.dropAddress.fullName = corrections.recipientname;
    if (corrections.recipientphone) order.dropAddress.phoneNumber = corrections.recipientphone;
    if (corrections.recipientfulladdress) order.dropAddress.fullAddress = corrections.recipientfulladdress;
    if (corrections.recipientbuildingno) order.dropAddress.buildingNo = corrections.recipientbuildingno;
    if (corrections.recipientfloor) order.dropAddress.floor = corrections.recipientfloor;
    if (corrections.recipientunit) order.dropAddress.unit = corrections.recipientunit;
    if (corrections.parcelweight) order.parcel.weight = corrections.parcelweight;
    if (corrections.parcelvalue) order.parcel.value = corrections.parcelvalue;


    const errors = validateSingleOrderData(order);

    if (errors.length > 0) {
        let errorMessage = "Thanks for the correction, but I still see some issues:\n";
        errorMessage += `- ${errors.join("\n- ")}\n\n`;
        errorMessage += "Please provide the remaining corrections or send a new photo.";
        await bot.sendMessage(chatId, errorMessage);
        return;
    }

    log("Single order correction successful", { order });
    await bot.sendMessage(chatId, "✅ Great, all details are now correct!");
    promptForSinglePickupLocation(chatId);
};


const startSingleOrder_Stepwise = (chatId) => {
    log(`Starting new SINGLE order (Stepwise) for user ${chatId}`);
    userState[chatId] = {
        action: "awaiting_single_order_step",
        orderType: "single",
        step: "pickup_fullName",
        history: ["start_stepwise"],
        order: {
            isDraft: false,
            pickupAddress: {},
            dropAddress: {},
            parcel: {},
        },
    };
    askSingleOrderQuestion(chatId, "pickup_fullName");
};

const askSingleOrderQuestion = (chatId, step) => {
    const state = userState[chatId];
    if (!state) return;

    if (state.history[state.history.length - 1] !== step) {
        state.history.push(step);
    }
    log(`Asking single order step: ${step}`, { history: state.history });

    const isButtonStep = ["parcel_size", "parcel_content", "delivery_type", "finalize"].includes(step);

    state.action = isButtonStep
        ? "awaiting_button_press"
        : "awaiting_single_order_step";
    state.step = step;

    if (isButtonStep) {
        if (step === "parcel_size") handleSingleParcelSize(chatId, "What is the parcel size?");
        else if (step === "parcel_content") handleSingleParcelContent(chatId, "What are the contents of the parcel?");
        else if (step === "delivery_type") handleSingleDeliveryType(chatId);
        // THIS LINE IS CHANGED
        else if (step === "finalize") calculateAndConfirmSingleOrder(chatId);
        return;
    }

    const keyboard = [];
    if (state.history.length > 2) {
        keyboard.push([{ text: "⬅️ Back", callback_data: "go_back" }]);
    }
    const skippableSteps = [
        "pickup_postalCode",
        "pickup_note",
        "drop_postalCode",
        "drop_note",
        "parcel_value",
    ];
    if (skippableSteps.includes(step)) {
        keyboard.push([
            { text: "➡️ Skip", callback_data: `skip_step_${step}` },
        ]);
    }

    const questions = {
        pickup_fullName: "**Pickup Details**\nWhat is the sender's full name?",
        pickup_phoneNumber: "What is the sender's phone number?",
        pickup_fullAddress: "What is the full pickup address?",
        pickup_location: "Please share the pickup location.",
        pickup_buildingNo: "Building/Apartment Number?",
        pickup_floor: "Floor?",
        pickup_unit: "Unit?",
        pickup_postalCode: "Postal Code? (optional)",
        pickup_note: "Any notes for the driver? (optional)",
        drop_fullName:
            "\n**Drop-off Details**\nWhat is the recipient's full name?",
        drop_phoneNumber: "What is the recipient's phone number?",
        drop_fullAddress: "What is the full drop-off address?",
        drop_location: "Please share the drop-off location.",
        drop_buildingNo: "Building/Apartment Number?",
        drop_floor: "Floor?",
        drop_unit: "Unit?",
        drop_postalCode: "Postal Code? (optional)",
        drop_note: "Any notes for the driver? (optional)",
        parcel_weight:
            "\n**Parcel Details**\nWhat is the parcel weight (in grams)?",
        parcel_value: "What is the estimated value of the parcel? (optional)",
    };

    const questionText = questions[step];
    if (questionText) {
        const options = {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: keyboard,
                remove_keyboard: !step.endsWith("_location"),
            },
        };
        if (step.endsWith("_location")) {
            state.action = step.includes("pickup")
                ? "awaiting_single_pickup_location"
                : "awaiting_single_dropoff_location";
            options.reply_markup = {
                keyboard: [
                    [
                        {
                            text: `Share ${step.includes("pickup") ? "Pickup" : "Drop-off"} Location`,
                            request_location: true,
                        },
                    ],
                    [{ text: "⬅️ Back" }],
                ],
                resize_keyboard: true,
                one_time_keyboard: true,
            };
        }
        bot.sendMessage(chatId, questionText, options);
    }
};

const findNextSingleOrderStep = (order, currentStep) => {
    const singleOrderStepOrder = [
        "pickup_fullName",
        "pickup_phoneNumber",
        "pickup_fullAddress",
        "pickup_location",
        "pickup_buildingNo",
        "pickup_floor",
        "pickup_unit",
        "pickup_postalCode",
        "pickup_note",
        "drop_fullName",
        "drop_phoneNumber",
        "drop_fullAddress",
        "drop_location",
        "drop_buildingNo",
        "drop_floor",
        "drop_unit",
        "drop_postalCode",
        "drop_note",
        "parcel_weight",
        "parcel_size",
        "parcel_content",
        "parcel_value",
        "delivery_type",
        "finalize",
    ];
    const startIndex = singleOrderStepOrder.indexOf(currentStep);
    if (startIndex === -1) return "finalize";
    for (let i = startIndex + 1; i < singleOrderStepOrder.length; i++) {
        const nextStep = singleOrderStepOrder[i];
        const [objKey, fieldKey] = nextStep.split("_");
        let data;
        if (objKey === "parcel") data = order.parcel?.[fieldKey];
        else if (objKey === "delivery" && fieldKey === "type")
            data = order.orderDeliveryType;
        else data = order[`${objKey}Address`]?.[fieldKey];
        if (data === undefined) return nextStep;
    }
    return "finalize";
};

const processSingleOrderStep = (chatId, msg) => {
    const state = userState[chatId];
    if (!state || !state.order) return;
    const { order, step } = state;
    let isValid = true;
    let errorMessage = "";
    const [objKey, fieldKey] = step.split("_");
    const targetAddress =
        objKey === "pickup" || objKey === "drop"
            ? order[`${objKey}Address`]
            : null;
    const targetParcel = objKey === "parcel" ? order.parcel : null;

    const text = msg.text;
    if (!text) {
        isValid = false;
        errorMessage = "Please provide a text response.";
    } else if (step.endsWith("_phoneNumber")) {
        const phoneValidation = isValidTurkishPhoneNumber(text);
        if (!phoneValidation.isValid) {
            isValid = false;
            errorMessage = phoneValidation.message;
        }
    } else if (step === "parcel_weight") {
        const weightValidation = isValidWeight(text);
        if (!weightValidation.isValid) {
            isValid = false;
            errorMessage = weightValidation.message;
        }
    } else if (step.endsWith("_buildingNo") && !isFourDigitsOrLess(text)) {
        isValid = false;
        errorMessage =
            "Building number must be a number with 4 digits or less.";
    } else if (
        step.endsWith("_postalCode") &&
        text &&
        text.toLowerCase() !== "skip" &&
        !isNumericString(text)
    ) {
        isValid = false;
        errorMessage = "Postal code must only contain numbers.";
    } else if (
        ["floor", "unit"].some((s) => step.endsWith(s)) &&
        !isFourDigitsOrLess(text)
    ) {
        isValid = false;
        errorMessage = "Floor/Unit must be a number with 4 digits or less.";
    } else if (
        step === "parcel_value" &&
        text.toLowerCase() !== "skip" &&
        !isNumericString(text)
    ) {
        isValid = false;
        errorMessage = "Please enter a valid number for the parcel value.";
    }

    if (isValid) {
        if (targetAddress) targetAddress[fieldKey] = text;
        if (targetParcel) targetParcel[fieldKey] = text;
        log("Single order step processed successfully", {
            step: step,
            data: msg.text,
        });
        const nextStep = findNextSingleOrderStep(order, step);
        askSingleOrderQuestion(chatId, nextStep);
    } else {
        log("Single order step validation failed", {
            step: step,
            error: errorMessage,
        });
        bot.sendMessage(chatId, `❌ ${errorMessage}\nPlease try again.`);
    }
};

const startSingleOrder_Bulk = (chatId) => {
    log(`Starting new SINGLE order (Bulk) for user ${chatId}`);
    userState[chatId] = {
        action: "awaiting_single_bulk_input",
        orderType: "single",
        history: ["start_bulk"],
        order: {
            isDraft: false,
            pickupAddress: {},
            dropAddress: {},
            parcel: {},
        },
    };
    const template = `
*Step 1: Provide Text Details*
Please copy this template, fill in the details, and send it back. Location and other options will be asked next with buttons.

*Pickup Details*
Sender Name:
Sender Phone:
Full Address:
Building No:
Floor:
Unit:
Postal Code (optional):
Note (optional):
---
*Drop-off Details*
Recipient Name:
Recipient Phone:
Full Address:
Building No:
Floor:
Unit:
Postal Code (optional):
Note (optional):
---
*Parcel Details*
Weight (grams):
Value (optional):
    `;
    bot.sendMessage(chatId, template, { parse_mode: "Markdown" });
};

const processSingleBulkInput = async (chatId, text) => {
    const state = userState[chatId];
    const { order } = state;

    const pickupStart = text.toLowerCase().indexOf("pickup details");
    const dropoffStart = text.toLowerCase().indexOf("drop-off details");
    const parcelStart = text.toLowerCase().indexOf("parcel details");

    if (pickupStart === -1 || dropoffStart === -1 || parcelStart === -1) {
        const errors = [
            "Template format not recognized. Please use the provided template with 'Pickup Details', 'Drop-off Details', and 'Parcel Details' sections.",
        ];
        await bot.sendMessage(
            chatId,
            `There were errors with your submission:\n- ${errors.join("\n- ")}\nPlease correct the template and send it again.`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "⬅️ Back", callback_data: "go_back" }],
                        [
                            {
                                text: "❌ Cancel Order",
                                callback_data: "cancel_order",
                            },
                        ],
                    ],
                },
            },
        );
        return;
    }

    const pickupText = text.substring(pickupStart, dropoffStart);
    const dropoffText = text.substring(dropoffStart, parcelStart);
    const parcelText = text.substring(parcelStart);

    const pickupData = parseTemplate(pickupText);
    const dropoffData = parseTemplate(dropoffText);
    const parcelData = parseTemplate(parcelText);

    order.pickupAddress = {
        fullName: pickupData["sender name"] || "",
        phoneNumber: pickupData["sender phone"] || "",
        fullAddress: pickupData["full address"] || "",
        buildingNo: pickupData["building no"] || "",
        floor: pickupData["floor"] || "",
        unit: pickupData["unit"] || "",
        postalCode:
            pickupData["postal code"] ||
            pickupData["postal code (optional)"] ||
            "",
        note: pickupData["note"] || pickupData["note (optional)"] || "",
    };
    order.dropAddress = {
        fullName: dropoffData["recipient name"] || "",
        phoneNumber: dropoffData["recipient phone"] || "",
        fullAddress: dropoffData["full address"] || "",
        buildingNo: dropoffData["building no"] || "",
        floor: dropoffData["floor"] || "",
        unit: dropoffData["unit"] || "",
        postalCode:
            dropoffData["postal code"] ||
            dropoffData["postal code (optional)"] ||
            "",
        note: dropoffData["note"] || dropoffData["note (optional)"] || "",
    };
    order.parcel = {
        weight: parcelData["weight (grams)"] || parcelData["weight"] || "",
        value: parcelData["value"] || parcelData["value (optional)"] || "",
    };

    const errors = validateSingleOrderData(order);

    if (errors.length > 0) {
        log("Single bulk input validation failed", { errors });
        await bot.sendMessage(
            chatId,
            `There were errors with your submission:\n- ${errors.join("\n- ")}\nPlease correct the template and send it again.`,
        );
        return;
    }

    log("Single bulk input parsed successfully", { order });
    await bot.sendMessage(
        chatId,
        "✅ Text details saved. Now for the locations and parcel options.",
    );
    promptForSinglePickupLocation(chatId);
};

const promptForSinglePickupLocation = (chatId) => {
    const state = userState[chatId];
    state.action = "awaiting_single_pickup_location";
    if (state.history[state.history.length - 1] !== state.action)
        state.history.push(state.action);
    bot.sendMessage(chatId, "*Step 2: Pickup Location*", {
        parse_mode: "Markdown",
        reply_markup: {
            keyboard: [
                [{ text: "Share Pickup Location", request_location: true }],
                [{ text: "⬅️ Back" }],
            ],
            resize_keyboard: true,
            one_time_keyboard: true,
        },
    });
};

const promptForSingleDropoffLocation = (chatId) => {
    const state = userState[chatId];
    state.action = "awaiting_single_dropoff_location";
    if (state.history[state.history.length - 1] !== state.action)
        state.history.push(state.action);
    bot.sendMessage(chatId, "*Step 3: Drop-off Location*", {
        parse_mode: "Markdown",
        reply_markup: {
            keyboard: [
                [{ text: "Share Drop-off Location", request_location: true }],
                [{ text: "⬅️ Back" }],
            ],
            resize_keyboard: true,
            one_time_keyboard: true,
        },
    });
};

const handleSingleCallbacks = async (chatId, data, msg) => {
    const state = userState[chatId];
    if (data === "go_back") {
        handleSingleOrderBackButton(chatId, state, msg.message_id);
    } else if (data.startsWith("skip_step_")) {
        state.action = "awaiting_single_order_step";
        handleSingleOrderSkip(chatId, data.replace("skip_step_", ""));
        try {
            await bot
                .deleteMessage(chatId, msg.message_id)
                .catch(console.error);
        } catch (error) {
            /* ... */
        }
    } else if (data.startsWith("parcel_size_")) {
        state.order.parcel.size = parseInt(
            data.replace("parcel_size_", ""),
            10,
        );
        try {
            await bot.editMessageText("Parcel size selected.", {
                chat_id: chatId,
                message_id: msg.message_id,
            });
        } catch (error) {
            /* ... */
        }
        askSingleOrderQuestion(chatId, "parcel_content");
    } else if (data.startsWith("parcel_content_")) {
        state.order.parcel.orderContent = data.replace("parcel_content_", "");
        try {
            await bot.editMessageText("Parcel content selected.", {
                chat_id: chatId,
                message_id: msg.message_id,
            });
        } catch (error) {
            /* ... */
        }
        askSingleOrderQuestion(chatId, "parcel_value");
    } else if (data.startsWith("delivery_type_")) {
        handleSingleDeliveryTypeSelection(
            chatId,
            data.replace("delivery_type_", ""),
            msg,
        );
    } else if (data.startsWith("choose_slot_")) {
        const slotIndex = parseInt(data.replace("choose_slot_", ""), 10);
        const selectedSlot = state.availableSlots[slotIndex];
        if (selectedSlot) {
            state.order.pickupDateTime = selectedSlot.pickupStartTime;
            state.order.dropOffDateTime = selectedSlot.dropOffStartTime;
            delete state.availableSlots;
            log("Set pickup and dropoff times from slot selection", {
                pickupDateTime: state.order.pickupDateTime,
                dropOffDateTime: state.order.dropOffDateTime,
            });
            try {
                await bot.editMessageText(`Time slot selected.`, {
                    chat_id: chatId,
                    message_id: msg.message_id,
                });
            } catch (error) {
                /* ... */
            }
            askSingleOrderQuestion(chatId, "finalize");
        } else {
            log("Error: Invalid slot index chosen.", { data });
            bot.sendMessage(
                chatId,
                "Sorry, that was an invalid slot. Please try again.",
            );
        }
    } else if (data === "confirm_order") {
        try {
            await bot.editMessageText("Submitting your order...", {
                chat_id: chatId,
                message_id: msg.message_id,
                reply_markup: {},
            });
        } catch (error) {
            /* ... */
        }
        submitSingleOrder(chatId);
    }
};

    const handleSingleOrderBackButton = (chatId, state, messageId) => {
        if (!state || !state.history || state.history.length <= 1) {
            bot.sendMessage(chatId, "You're at the beginning. You can /start over to cancel.");
            return;
        }
        try { if (messageId) bot.deleteMessage(chatId, messageId).catch(console.error); } catch (error) { /* ... */ }

        const currentStep = state.history.pop();
        const previousStep = state.history[state.history.length - 1];
        log(`Back button pressed. From ${currentStep} to ${previousStep}`);

    // Clean up data from the step we are leaving
    const [objKey, fieldKey] = (currentStep || "").split("_");
    if (objKey === "parcel") delete state.order.parcel[fieldKey];
    else if (objKey === "pickup" || objKey === "drop") delete state.order[`${objKey}Address`][fieldKey];
    else if (currentStep === "delivery_type") {
        delete state.order.orderDeliveryType;
        delete state.order.pickupDateTime;
        delete state.order.dropOffDateTime;
    } else if (currentStep === "finalize") {
        delete state.order.pickupDateTime;
        delete state.order.dropOffDateTime;
    }

    // CORRECTED: This logic correctly handles going back to the start of either flow
    // without deleting the state object prematurely.
 if (previousStep.startsWith("start_")) {
        if (previousStep.includes("bulk")) {
            startSingleOrder_Bulk(chatId);
        } else {
            startSingleOrder_Stepwise(chatId);
        }
    } else if (previousStep === 'awaiting_single_pickup_location') {
        // If the previous step was the bulk pickup location prompt, call it again.
        promptForSinglePickupLocation(chatId);
    } else {
        // Otherwise, it's a normal step-by-step question.
        askSingleOrderQuestion(chatId, previousStep);
    }
};
const handleSingleOrderSkip = (chatId, stepToSkip) => {
    const state = userState[chatId];
    if (!state || !state.order) return;
    const nextStep = findNextSingleOrderStep(state.order, stepToSkip);
    askSingleOrderQuestion(chatId, nextStep);
};

const handleSingleParcelSize = (chatId, title) => {
    bot.sendMessage(chatId, title, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "Small", callback_data: "parcel_size_1" },
                    { text: "Medium", callback_data: "parcel_size_2" },
                ],
                [
                    { text: "Large", callback_data: "parcel_size_3" },
                    { text: "Extra Large", callback_data: "parcel_size_4" },
                ],
                [{ text: "⬅️ Back", callback_data: "go_back" }],
            ],
            remove_keyboard: true,
        },
    });
};

const handleSingleParcelContent = (chatId, title) => {
    bot.sendMessage(chatId, title, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "Food", callback_data: "parcel_content_Food" },
                    { text: "Gifts", callback_data: "parcel_content_Gifts" },
                ],
                [
                    {
                        text: "Documents",
                        callback_data: "parcel_content_Documents",
                    },
                    { text: "Flower", callback_data: "parcel_content_Flower" },
                ],
                [
                    {
                        text: "Personal",
                        callback_data: "parcel_content_Personal",
                    },
                    { text: "Others", callback_data: "parcel_content_Others" },
                ],
                [{ text: "⬅️ Back", callback_data: "go_back" }],
            ],
            remove_keyboard: true,
        },
    });
};

const handleSingleDeliveryType = (chatId) => {
    const title = "*Step 6: Delivery Option*";
    bot.sendMessage(chatId, title, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: "On Demand",
                        callback_data: "delivery_type_OnDemand",
                    },
                ],
                [{ text: "SlotTime", callback_data: "delivery_type_SlotTime" }],
                [{ text: "⬅️ Back", callback_data: "go_back" }],
            ],
            remove_keyboard: true,
        },
    });
};

const handleSingleDeliveryTypeSelection = async (chatId, deliveryType, msg) => {
    const state = userState[chatId];
    state.order.orderDeliveryType = deliveryType;
    if (deliveryType === "SlotTime") {
        state.action = "awaiting_button_press";
        try {
            await bot.editMessageText("Fetching available time slots...", {
                chat_id: chatId,
                message_id: msg.message_id,
                reply_markup: {},
            });
            const url =
                "https://yolpak-api.shinypi.net/order/sameDay-activeTimes";
            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${userDB[chatId].token}` },
            });
            if (!response.data.isSuccess)
                throw new Error(
                    response.data.message || "Failed to fetch slots.",
                );
            const pickupSlots = response.data.data || [];
            const validSlots = [];
            let messageText = "*Please choose an available time slot:*\n\n";
            const timeSlotButtons = [];
            let buttonRow = [];
            pickupSlots.forEach((pickupSlot) => {
                if (
                    pickupSlot.deliveries &&
                    pickupSlot.deliveries.length > 0 &&
                    pickupSlot.deliveries[0].startDateTime
                ) {
                    const dropOffSlot = pickupSlot.deliveries[0];
                    const slotData = {
                        pickupStartTime: pickupSlot.startDateTime,
                        dropOffStartTime: dropOffSlot.startDateTime,
                    };
                    validSlots.push(slotData);
                    const slotIndex = validSlots.length - 1;
                    messageText += `*Slot ${slotIndex + 1}:*\n  - Pickup: ${formatDateTime(slotData.pickupStartTime)}\n  - Drop-off: ${formatDateTime(slotData.dropOffStartTime)}\n\n`;
                    buttonRow.push({
                        text: `Slot ${slotIndex + 1}`,
                        callback_data: `choose_slot_${slotIndex}`,
                    });
                    if (buttonRow.length === 3) {
                        timeSlotButtons.push(buttonRow);
                        buttonRow = [];
                    }
                }
            });
            if (buttonRow.length > 0) {
                timeSlotButtons.push(buttonRow);
            }
            if (validSlots.length > 0) {
                userState[chatId].availableSlots = validSlots;
                timeSlotButtons.push([
                    { text: "⬅️ Back", callback_data: "go_back" },
                ]);
                await bot.editMessageText(messageText, {
                    chat_id: chatId,
                    message_id: msg.message_id,
                    parse_mode: "Markdown",
                    reply_markup: { inline_keyboard: timeSlotButtons },
                });
            } else {
                throw new Error(
                    "No available time slots with valid drop-off times were found.",
                );
            }
        } catch (error) {
            log("Error fetching time slots", { error: error.message });
            await bot.editMessageText(
                `Sorry, I couldn't fetch the time slots: ${error.message}`,
                {
                    chat_id: chatId,
                    message_id: msg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "⬅️ Back", callback_data: "go_back" }],
                        ],
                    },
                },
            );
        }
    } else {
        try {
            await bot.editMessageText(`You selected "On Demand".`, {
                chat_id: chatId,
                message_id: msg.message_id,
                reply_markup: {},
            });
        } catch (error) {
            /* ... */
        }
        askSingleOrderQuestion(chatId, "finalize");
    }
};

const calculateAndConfirmSingleOrder = async (chatId) => {
    const state = userState[chatId];
    if (!state || !state.order) return;
    state.action = 'awaiting_button_press';

    try {
        await bot.sendMessage(chatId, "Please wait, calculating your order price...", { reply_markup: { remove_keyboard: true } });
        const { order } = state;
        const userToken = userDB[chatId].token;

        const pricingPayload = {
            sourceLatitude: order.pickupAddress.latitude,
            sourceLongitude: order.pickupAddress.longitude,
            destinationLatitude: order.dropAddress.latitude,
            destinationLongitude: order.dropAddress.longitude,
            size: order.parcel.size || 1,
            deliveryType: order.orderDeliveryType || "OnDemand",
            weight: parseInt(order.parcel.weight) || 0,
        };

        const url = "https://yolpak-api.shinypi.net/pricing/single-calc-cost";
        const response = await axios.post(url, pricingPayload, { headers: { Authorization: `Bearer ${userToken}` } });

        // Step 1: Enhanced Logging - This is key!
        log("Full pricing API response data:", response.data);

        // Step 2: More Robust Validation
        if (!response.data || !response.data.isSuccess) {
            const errorMessage = response.data?.message || "API request failed with no error message.";
            throw new Error(errorMessage);
        }

        const priceData = response.data.data;
        if (!priceData || typeof priceData !== 'object') {
            log("Error: response.data.data is missing or not an object.", priceData);
            throw new Error("Received an invalid price data format from the server.");
        }

        // --- NEW PRICE HANDLING LOGIC ---
        // This correctly handles a price of 0.
        // YOU MUST REPLACE 'deliveryFee' and 'totalAmount' with the actual keys from your logs.
        const deliveryPrice = (priceData.deliveryPrice !== undefined && priceData.deliveryPrice !== null)
            ? priceData.deliveryPrice
            : "N/A";
        const totalPrice = (priceData.total !== undefined && priceData.total !== null)
            ? priceData.total
            : "N/A";
        // --- END OF FIX ---

        const priceSummary = `*Price Summary:*\n- Delivery Cost: ${deliveryPrice}\n------------------\n*Total: ${totalPrice}*`;

        const p = order.pickupAddress;
        const d = order.dropAddress;
        const parcel = order.parcel;
        const sizeMap = { 1: "Small", 2: "Medium", 3: "Large", 4: "Extra Large" };
        let finalSummary = `*Please confirm your order details:*\n\n`;
        finalSummary += `*Pickup Details*\n- Name: ${p.fullName || "N/A"}\n- Phone: ${p.phoneNumber || "N/A"}\n- Address: ${p.fullAddress || "N/A"}\n`;
        if (p.latitude && p.longitude) { finalSummary += `- Location: [View on Map](https://maps.google.com/?q=${p.latitude},${p.longitude})\n`; }
        finalSummary += `- Building/Floor/Unit: ${p.buildingNo || "N/A"} / ${p.floor || "N/A"} / ${p.unit || "N/A"}\n- Postal Code: ${p.postalCode || "N/A"}\n- Note: ${p.note || "N/A"}\n\n`;
        finalSummary += `*Drop-off Details*\n- Name: ${d.fullName || "N/A"}\n- Phone: ${d.phoneNumber || "N/A"}\n- Address: ${d.fullAddress || "N/A"}\n`;
        if (d.latitude && d.longitude) { finalSummary += `- Location: [View on Map](https://maps.google.com/?q=${d.latitude},${d.longitude})\n`; }
        finalSummary += `- Building/Floor/Unit: ${d.buildingNo || "N/A"} / ${d.floor || "N/A"} / ${d.unit || "N/A"}\n- Postal Code: ${d.postalCode || "N/A"}\n- Note: ${d.note || "N/A"}\n\n`;
        finalSummary += `*Parcel Details*\n- Content: ${parcel.orderContent || "N/A"}\n- Weight: ${parcel.weight || "N/A"}g\n- Size: ${sizeMap[parcel.size] || "N/A"}\n- Value: ${parcel.value || "N/A"}\n\n`;
        finalSummary += `*Delivery Details*\n- Type: ${order.orderDeliveryType || "N/A"}\n`;
        if (order.orderDeliveryType === "SlotTime") {
            finalSummary += `- Pickup Time: ${formatDateTime(order.pickupDateTime)}\n- Drop-off Time: ${formatDateTime(order.dropOffDateTime)}\n`;
        }

        await bot.sendMessage(chatId, finalSummary + "\n" + priceSummary, { parse_mode: "Markdown", disable_web_page_preview: true });
        await bot.sendMessage(chatId, "Confirm to submit?", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✅ Confirm Order", callback_data: "confirm_order" }],
                    [{ text: "⬅️ Back", callback_data: "go_back" }, { text: "❌ Cancel", callback_data: "cancel_order" }]
                ]
            },
        });

    } catch (error) {
        log("Error calculating single order price", { error: error.message });
        await bot.sendMessage(chatId, `❌ An error occurred while calculating the price: ${error.message}`, {
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "go_back" }]] },
        });
    }
};
const submitSingleOrder = async (chatId) => {
    log(`Submitting single order for user ${chatId}`);
    const state = userState[chatId];
    if (!state || !state.order) return;
    const { order } = state;
    const userToken = userDB[chatId].token;
    if (order.orderDeliveryType === "OnDemand") {
        const now = new Date().toISOString();
        order.pickupDateTime = now;
        order.dropOffDateTime = now;
    }
    const valueOrNull = (value) =>
        value === "" || isNaN(parseFloat(value)) ? null : parseFloat(value);
    const finalPayload = {
        pickupDateTime: order.pickupDateTime,
        dropOffDateTime: order.dropOffDateTime || order.pickupDateTime,
        orderDeliveryType: order.orderDeliveryType,
        isDraft: false,
        pickupAddress: { ...order.pickupAddress },
        dropAddress: { ...order.dropAddress },
        parcel: {
            weight: parseInt(order.parcel.weight) || 0,
            size: order.parcel.size,
            orderContent: order.parcel.orderContent,
            value: valueOrNull(order.parcel.value),
        },
    };
    log("Submitting final single order payload", finalPayload);
    try {
        const url = "https://yolpak-api.shinypi.net/order/single";
        const response = await axios.post(url, finalPayload, {
            headers: { Authorization: `Bearer ${userToken}` },
        });
        if (!response.data.isSuccess)
            throw new Error(
                response.data.errors
                    ? JSON.stringify(response.data.errors)
                    : response.data.message || "Failed to submit order.",
            );
        await bot.sendMessage(
            chatId,
            "✅ Your order has been successfully submitted! Thank you.",
            {
                reply_markup: {
                    keyboard: [
                        ["Submit New Order"],
                        ["Add Funds", "Check Balance"],
                    ],
                    resize_keyboard: true,
                },
            },
        );
        saveOrder(chatId, finalPayload);
    } catch (error) {
        let errorMessage = error.message;
        if (error.response && error.response.data) {
            const apiError = error.response.data;
            log("API Error Response", apiError);
            if (apiError.message) errorMessage = apiError.message;
            else if (apiError.errors)
                errorMessage = Array.isArray(apiError.errors)
                    ? apiError.errors.join(", ")
                    : JSON.stringify(apiError.errors);
            if (
                errorMessage.toLowerCase().includes("balance") ||
                errorMessage.toLowerCase().includes("insufficient") ||
                errorMessage.toLowerCase().includes("funds")
            ) {
                errorMessage = `💰 ${errorMessage}\n\nYou can add funds using the 'Add Funds' button in the main menu.`;
            }
        }
        log("Error in submitSingleOrder", { error: errorMessage });
        await bot.sendMessage(
            chatId,
            `❌ An error occurred while submitting your order: ${errorMessage}`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "⬅️ Back", callback_data: "go_back" }],
                    ],
                },
            },
        );
    } finally {
        delete userState[chatId];
    }
};

// At the end of handlers/singleOrder.js

module.exports = {
    promptForSingleOrderMode,
    startSingleOrder_Stepwise,
    processSingleOrderStep,
    startSingleOrder_Bulk,
    processSingleBulkInput,
    promptForSinglePickupLocation,
    promptForSingleDropoffLocation,
    handleSingleCallbacks,
    handleSingleOrderBackButton,
    askSingleOrderQuestion,
    submitSingleOrder,
    findNextSingleOrderStep, // <-- ADD THIS LINE
    startSingleOrder_Picture,
    processSinglePicture,
    processSingleOrderCorrection,
};
