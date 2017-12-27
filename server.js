/** @namespace socket.decoded_token */
const cors = require('cors')();
const express = require('express');
const app = express();
app.enable('trust proxy');
require('dotenv').config();
const jwt = require('jsonwebtoken');
const geo = require('./modules/geo');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const geoLib = require('geolib');
const bluebird = require('bluebird');
global.fs = bluebird.promisifyAll(require("fs"));
const bodyParser = require('body-parser');
const socketioJwt = require('socketio-jwt');
const redis = require('./modules/redisdb');
const mysql = require('./modules/mysqldb');
const uploader = require('./modules/uploader');
global.onlineDrivers = new Set();
global.riderPrefix = "rider:";
global.driverPrefix = "driver:";
global.travelPrefix = "travel:";
global.operatorPrefix = "operator:";
global.publicDir = __dirname + "/public/";
let baseData = null;
updateBaseData();
async function updateBaseData() {
    if (baseData == null) {
        try {
            baseData = await mysql.operator.getBaseData();
        }
        catch (error) {
            console.log("Error in connecting to database " + process.env.SQL_DATABASE + " Press any key to exit...(" + error.code + ")");
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', process.exit.bind(process, 0));
        }
    }
    operatorsNamespace.emit("alertsCountChanged", baseData.waiting_complaints, baseData.unpaid_count);
}
async function driverInfoChanged(driverId) {
    let [ignored, connectionId] = await Promise.all([
        mysql.driver.updateInfoChangedStatus(driverId, true),
        redis.getConnectionId(driverPrefix + driverId)
    ]);
    if (connectionId != null) {
        let [profile, travelTypes] = await Promise.all([
            mysql.driver.getProfile(driverId),
            mysql.driver.getTravelTypes(driverId)
        ]);
        io.to(connectionId).emit('driverInfoChanged', profile, travelTypes);
        mysql.driver.updateInfoChangedStatus(driverId, false);
    }
}
async function riderInfoChanged(riderId) {
    let [ignored, connectionId] = await Promise.all([
        mysql.rider.updateInfoChangedStatus(riderId, true),
        redis.getConnectionId(riderPrefix + riderId)
    ]);
    if (connectionId != null) {
        let profile = await mysql.rider.getProfile(riderId);
        io.to(connectionId).emit('riderInfoChanged', profile);
        mysql.rider.updateInfoChangedStatus(riderId, false);
    }
}
app.use(cors);
app.options('*', cors);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));
app.get('/', (req, res) => {
    res.status(200).send(process.env.STRIPE_SECRET_KEY).end();
});
app.use('/img', express.static(__dirname + "/public/img"));
app.post("/operator_login", async function (req, res) {
    try {
        let operator = (await mysql.operator.authenticate(req.query.email, req.query.password));
        let keys = {
            id: operator.id,
            connection_prefix: operatorPrefix,
            p_st: operator.access_stats,
            p_bt: operator.access_base_types,
            p_us: operator.access_users,
            p_dr: operator.access_drivers,
            p_tr: operator.access_travels,
            p_cm: operator.access_complaints,
            p_cr: operator.access_call_requests,
            p_pr: operator.access_payment_requests
        };
        //let token = jwt.sign(keys, process.env.JWT_SECRET, {expiresIn: 300});
        let token = jwt.sign(keys, process.env.JWT_SECRET, {});
        let result = {
            id: operator.id,
            name: operator.first_name + ' ' + operator.last_name,
            image: uploader.getRelativePath(IMAGE_OPERATOR, operator.image_address),
            email: operator.email,
            token: token,
            p_st: operator.access_stats,
            p_bt: operator.access_base_types,
            p_us: operator.access_users,
            p_dr: operator.access_drivers,
            p_tr: operator.access_travels,
            p_cm: operator.access_complaints,
            p_cr: operator.access_call_requests,
            p_pr: operator.access_payment_requests
        };
        await mysql.operator.setNotRevoked(operator.id);
        res.json(result);
    }
    catch (err) {
        res.json({error: err.message});
    }
});
app.post('/rider_login', async function (req, res) {
    if (process.env.RIDER_MIN_VERSION && req.body.version && parseInt(req.body.version) < process.env.RIDER_MIN_VERSION) {
        res.json({status: 410, error: "Upgrade to new version"});
        return;
    }
    let profile = await mysql.rider.getProfile(parseInt(req.body.user_name));
    let keys = {
        id: profile.id,
        connection_prefix: riderPrefix
    };
    let token = jwt.sign(keys, process.env.JWT_SECRET, {});
    res.json({status: 200, token: token, user: profile});
});
app.post('/driver_login', async function (req, res) {
    if (process.env.DRIVER_MIN_VERSION && req.body.version && parseInt(req.body.version) < process.env.DRIVER_MIN_VERSION) {
        res.json({status: 410, error: "Upgrade to new version"});
        return;
    }
    let profile = await mysql.driver.getProfile(parseInt(req.body.user_name));
    if (profile == null) {
        res.json({status: 504, error: "Your access has been denied. Please contact app provider."});
        return;
    }
    let travelTypes = await mysql.driver.getTravelTypes(profile.id);
    let keys = {
        id: profile.id,
        connection_prefix: driverPrefix
    };
    let token = jwt.sign(keys, process.env.JWT_SECRET, {});
    res.json({status: 200, token: token, user: profile, travelTypes: travelTypes});
});
let server = require('http').createServer(app);
let io = require('socket.io')(server);
io.use(socketioJwt.authorize({
    secret: process.env.JWT_SECRET,
    handshake: true
}));
let operatorsNamespace = io.of('/operators').use(socketioJwt.authorize({
    secret: process.env.JWT_SECRET,
    handshake: true
})).on('connection', function (socket) {
    if (socket.decoded_token.connection_prefix == operatorPrefix) {
        mysql.operator.getIsRevoked(socket.decoded_token.id).then(function (result) {
            if ((result[0][0]).is_revoked) {
                socket.error("access_revoked");
                socket.disconnect();
            }
        });
    }
    socket.on('getAllComplaints', async function (searchTerm, sort, from, pageSize, isReviewed, callback) {
        let result = (await mysql.operator.getAllComplaints(searchTerm, sort, from, pageSize, isReviewed))[0];
        if (result.length)
            result[0].count = isReviewed ? baseData.reviewed_complaints : baseData.waiting_complaints;
        callback(result);
    });
    socket.on('getAllCars', async function (callback) {
        let cars = await mysql.operator.getAllCars();
        callback(cars[0]);
    });
    socket.on('getAllDrivers', async function (searchTerm, sort, from, pageSize, callback) {
        let result = (await mysql.operator.getAllDrivers(searchTerm, sort, from, pageSize))[0];
        for (item of result)
            if (item.mobile_number && item.mobile_number > 10000 && process.env.TEST_MODE != "true")
                item.mobile_number = "*****" + item.mobile_number.toString().substr(5);
        if (result.length)
            result[0].count = baseData.driver_count;

        callback(result);
    });
    socket.on('deleteDrivers', async function (Ids, callback) {
        await mysql.operator.deleteDrivers(Ids);
        baseData.driver_count = baseData.driver_count - Ids.length;
        for(id of Ids){
            driverInfoChanged(id);
        }
        callback();
    });
    socket.on('addDriver', async function (callback) {
        let result = await mysql.operator.insertRow('driver');
        baseData.driver_count++;
        callback(result[0].insertId);
    });
    socket.on('getAllTravels', async function (searchTerm, sort, from, pageSize, callback) {
        let result = (await mysql.operator.getAllTravels(searchTerm, sort, from, pageSize))[0];
        if (result.length)
            result[0].count = baseData.travel_count;
        callback(result);
    });
    socket.on('getAllPaymentRequests', async function (searchTerm, sort, from, pageSize, isPaid, callback) {
        let result = (await mysql.driver.getAllPaymentRequests(searchTerm, sort, from, pageSize, isPaid ? 'paid' : 'pending'))[0];
        if (result.length)
            result[0].count = isPaid ? baseData.paid_count : baseData.unpaid_count;
        callback(result);
    });
    socket.on('markPaymentRequestsPaid', async function (Ids, callback) {
        let driverIds = await mysql.driver.markPaymentRequestsPaid(Ids);
        baseData.paid_count++;
        baseData.unpaid_count--;
        updateBaseData();
        for (let driverId of driverIds)
            driverInfoChanged(driverId);
        callback(200);
    });
    socket.on('getReviews', async function (driverId, callback) {
        callback((await mysql.operator.getDriverReviews(driverId))[0]);
    });
    socket.on('getAllTravelTypes', async function (callback) {
        callback((await mysql.travelType.getAll())[0]);
    });
    socket.on('getDriverTravelTypes', async function (driverId, callback) {
        let tt = (await mysql.travelType.getDriverTravelTypes(driverId))[0];
        tt = tt.map(x => x.id);
        callback(tt);
    });
    socket.on('setDriverTravelTypes', async function (driverId, travelTypeIds) {
        await mysql.travelType.deleteDriverTravelType(driverId);
        await mysql.travelType.setDriverTravelTypes(driverId, travelTypeIds);
        driverInfoChanged(driverId);
    });
    socket.on('markComplaintsReviewed', async function (Ids, callback) {
        await mysql.operator.markComplaintsReviewed(Ids);
        callback(200);
    });
    socket.on('getCallRequests', async function (from, pageSize, callback) {
        let reqs = await redis.getCallRequests(from, pageSize);
        let result = await Promise.all(reqs);
        callback(result);
    });
    socket.on('deleteCallRequests', async function (Ids, callback) {
        await redis.deleteCallRequests(Ids);
        callback(200);
    });
    socket.on('getTableIds', async function (tableName, searchTerm, sort, from, pageSize) {
        return await mysql.operator.getAllComplaints(searchTerm, sort, from, pageSize);
    });
    socket.on('getTableRows', function (tableName, Ids, callback) {
        mysql.operator.getTableRows(tableName, Ids, function (result) {
            callback(result);
        });
    });
    socket.on('setColumnValue', async function (tableName, id, column, value, callback) {
        let availableTables = [];
        if (process.env.TEST_MODE && process.env.TEST_MODE == true && tableName == "operator")
            return;
        if (socket.decoded_token.p_bt > 1) {
            availableTables.push("car");
            availableTables.push("complaint_type_driver");
            availableTables.push("complaint_type_rider");
            availableTables.push("driver_type");
            availableTables.push("travel_type");
        }
        if (socket.decoded_token.p_dr > 1)
            availableTables.push('driver');
        if (socket.decoded_token.p_us > 1)
            availableTables.push('operator');
        if (socket.decoded_token.p_cm > 1)
            availableTables.push("travel_complaint");
        if (socket.decoded_token.p_pr > 1)
            availableTables.push("payment_request");
        if (availableTables.indexOf(tableName) == -1)
            return;
        switch (tableName) {
            case('operator'):
                mysql.operator.setRevoked(id);
                break;
            case('driver'):
                driverInfoChanged(id);
                break;
            case ('rider'):
                riderInfoChanged(id);
                break;
            case('travel_type'):
                let drivers = await mysql.travelType.getDriversWithTravelType(id);
                for (let driver of drivers) {
                    driverInfoChanged(driver);
                }
        }
        mysql.operator.setColumnValue(tableName, id, column, value, function (result) {
            console.log(result);
            callback(result);
        });
    });
    socket.on('getTodos', async function (callback) {
        let result = (await mysql.operator.getTodos(socket.decoded_token.id))[0];
        callback(result);
    });
    socket.on('addTodo', async function (title, callback) {
        await mysql.operator.addTodo(socket.decoded_token.id, title);
        callback();
    });
    socket.on('markTodosDone', async function (Ids, callback) {
        await mysql.operator.markTodosDone(Ids);
        callback();
    });
    socket.on('deleteTodos', async function (Ids, callback) {
        await mysql.operator.deleteTodos(Ids);
        callback();
    });
    socket.on('getReminders', async function (date, callback) {
        let result = (await mysql.operator.getReminders(socket.decoded_token.id, date))[0];
        callback(result);
    });
    socket.on('addReminder', async function (date, title, callback) {
        await mysql.operator.addReminder(socket.decoded_token.id, date, title);
        callback();
    });
    socket.on('deleteReminder', async function (Id, callback) {
        await mysql.operator.deleteReminder(Id);
        callback();
    });
    socket.on('getAllOperators', async function (sort, from, pageSize, callback) {
        let result = (await mysql.operator.getAll(sort, from, pageSize))[0];
        callback(result);
    });
    socket.on('addOperator', async function (callback) {
        let result = await mysql.operator.insertRow('operator');
        callback(result[0].insertId);
    });
    socket.on('deleteOperators', async function (Ids, callback) {
        await mysql.operator.deleteOperators(Ids);
        callback();
    });
    socket.on('updateOperatorProfile', async function (buffer, callback) {
        if (socket.decoded_token.connection_prefix == operatorPrefix) {
            let fileName = await uploader.doUpload(IMAGE_OPERATOR, buffer, socket.decoded_token.id);
            callback(200, fileName);
        }
    });
    socket.on('setRideImage', async function (buffer, Id, callback) {
        if (socket.decoded_token.p_bt > 1) {
            let fileName = await uploader.doUpload(IMAGE_RIDE, buffer, Id);
            callback(200, fileName);
        }
    });
    socket.on('updateOperatorPassword', async function (oldPass, newPass, callback) {
        if (process.env.TEST_MODE && process.env.TEST_MODE == "true")
            return;
        let result = (await mysql.operator.updateOperatorPassword(socket.decoded_token.id, oldPass, newPass))[0];
        if (result.affectedRows == 1) {
            callback(200);
        }
        else {
            callback(403);
        }
    });
    socket.on('getBaseData', function (callback) {
        callback(baseData);
    });
    socket.on('getIncomes', async function (groupBy, muchAgo, callback) {
        if (socket.decoded_token.p_st > 1)
            callback((await mysql.serverStats.incomes(groupBy, muchAgo))[0]);
    });
    socket.on('getServicesCount', async function (groupBy, muchAgo, callback) {
        if (socket.decoded_token.p_st > 0)
            callback((await mysql.serverStats.servicesCount(groupBy, muchAgo))[0]);
    });
    socket.on('getNewUsers', async function (groupBy, muchAgo, callback) {
        if (socket.decoded_token.p_st > 0)
            callback((await mysql.serverStats.newUsers(groupBy, muchAgo))[0]);
    });
    socket.on('getBaseTypes', async function (type, sort, from, pageSize, callback) {
        let result = (await mysql.operator.getBaseTypes(type, sort, from, pageSize))[0];
        if (type == 'car')
            result = result.map(function (item) {
                return {
                    count: item.count,
                    id: item.id,
                    title: item.title,
                    image_address: uploader.getRelativePath(IMAGE_RIDE, item.image_address)
                }
            });
        callback(result);
    });
    socket.on('addBaseType', async function (type, callback) {
        let result = (await mysql.operator.addBaseType(type))[0].insertId;
        callback(result);
    });
    socket.on('deleteBaseTypes', async function (type, Ids, callback) {
        await mysql.operator.deleteBaseTypes(type, Ids);
        callback();
    });
    socket.on('getAlertsCount', function () {
        updateBaseData();
    });
});
io.on('connection', function (socket) {
    redis.setConnectionId(socket.decoded_token.connection_prefix + socket.decoded_token.id, socket.id);
    if (socket.decoded_token.connection_prefix == driverPrefix) {
        operatorsNamespace.emit("ChangeDriversOnline", onlineDrivers.size);
        mysql.driver.getIsInfoChanged(socket.decoded_token.id).then(function (isChanged) {
            if (isChanged)
                driverInfoChanged(socket.decoded_token.id);
        });
    }
    if (socket.decoded_token.connection_prefix == riderPrefix) {
        mysql.rider.getIsInfoChanged(socket.decoded_token.id).then(function (isChanged) {
            if (isChanged)
                riderInfoChanged(socket.decoded_token.id);
        });
    }

    console.log('User connected with ID :' + socket.decoded_token.id);
    socket.on('disconnect', function () {
        redis.deleteUser(socket.decoded_token.connection_prefix + socket.decoded_token.id);
        if (socket.decoded_token.connection_prefix == driverPrefix) {
            mysql.driver.setState(socket.decoded_token.id, DRIVER_STATE_OFFLINE);
            operatorsNamespace.emit("ChangeDriversOnline", onlineDrivers.size);
        }
    });
    socket.on('changeStatus', async function (statusCode, callback) {
        callback(200, mysql.driver.setState(socket.decoded_token.id, statusCode));
    });
    socket.on('locationChanged', function (lat, lng) {
        redis.setLocation(socket.decoded_token.connection_prefix + socket.decoded_token.id, lat, lng);
    });

    socket.on('requestTaxi', async function (pickupLat, pickupLng, dropOffLat, dropOffLng, pickupLocation, dropOffLocation, callback) {
        const pickUpPoint = geo.latLngToPoint(pickupLat, pickupLng);
        const dropOffPoint = geo.latLngToPoint(dropOffLat, dropOffLng);
        try {
            const locations = await redis.getLocations(driverPrefix, onlineDrivers);
            let closeOnes = geo.orderCoordinates(pickUpPoint, locations, process.env.MAX_DRIVERS_SEND_REQUEST, process.env.MAX_DISTANCE_TO_SEND_REQUEST);
            let driverDistances = await Promise.all(await geo.calculateDistances(pickUpPoint, closeOnes));
            driverDistances = driverDistances.map(geo.geoParser);
            let travelDistance = geo.geoParser(await geo.calculateDistance(pickUpPoint, dropOffPoint));
            const travel = await mysql.travel.insert(socket.decoded_token.id, pickUpPoint, dropOffPoint, pickupLocation, dropOffLocation, travelDistance.distance.value, travelDistance.duration.value);
            callback(200, closeOnes.length);
            for (let i = 0; i < closeOnes.length; i++) {
                let conId = await redis.getConnectionId(driverPrefix + closeOnes[i].id);
                io.to(conId).emit('requestReceived', travel, travelDistance.distance.text, driverDistances[i].distance.text);
            }
            await redis.assignDriversToTravel(travel.id, closeOnes.map(x => x.id));
            socket.travelId = travel.id;
        }
        catch (err) {
            //TODO:Solve Message texts
            const errorNum = parseInt(err.message);
            if (errorNum && errorNum > 0)
                callback(errorNum);
            else
                callback(666, err.message);
        }
    });
    socket.on('driverAccepted', async function (travelId) {
        let [ignored, driver, riderId] = await Promise.all([
            mysql.travel.setState(travelId, mysql.travel.TRAVEL_STATE_DRIVER_ACCEPTED),
            mysql.driver.getDriverInfo(socket.decoded_token.id),
            mysql.travel.getRiderId(travelId)]);
        socket.riderId = riderId;
        if (driver.car_image == "")
            driver.car_image = driver.car_image_shared;
        let [connectionId, travel, driverLocation] = await Promise.all([
            redis.getConnectionId(riderPrefix + riderId),
            mysql.travel.getById(travelId),
            redis.getLocation(driverPrefix + driver.id)
        ]);
        let travelDistance = geo.geoParser(await geo.calculateDistance(driverLocation, {
            latitude: travel.from_lat,
            longitude: travel.from_lng
        }));
        io.to(connectionId).emit('driverAccepted', driver, travelDistance.distance.value, travelDistance.duration.value);
    });
    socket.on('riderAccepted', async function (driverId, callback) {
        let [ignored, ignored2, travel, connectionId] = await Promise.all([
            mysql.travel.setDriver(socket.travelId, driverId),
            mysql.driver.setState(driverId, DRIVER_STATE_IN_SERVICE),
            mysql.travel.getById(socket.travelId),
            redis.getConnectionId(driverPrefix + driverId)
        ]);
        socket.driverId = driverId;
        io.to(connectionId).emit('riderAccepted', travel);
        let otherDrivers = await redis.getDriversAssignedToTravel(socket.travelId);
        //TODO:Do this correctly,There is an Error here
        let connectionIds = await Promise.all(await redis.getConnectionIds(driverPrefix, otherDrivers));
        for (const conId of connectionIds) {
            if (conId != connectionId)
                io.to(conId).emit('anotherDriverAccepted');
        }
        callback(200, travel.from_lat, travel.from_lng, travel.to_lat, travel.to_lng);
    });
    socket.on('buzz', async function () {
        let riderId = await mysql.travel.getRiderIdByDriverId(socket.decoded_token.id);
        let connectionId = await redis.getConnectionId(riderPrefix + riderId);
        io.to(connectionId).emit('driverInLocation');
    });
    socket.on('callRequest', async function (callback) {
        let callData = (await mysql.travel.getCallData(socket.decoded_token.id))[0][0];
        redis.addCallRequest(callData);
        operatorsNamespace.emit('callRequested', callData);
        callback(200);
    });
    socket.on('startTravel', async function (travelTypeId) {
        let [riderId, travelId] = await Promise.all([
            mysql.travel.getRiderIdByDriverId(socket.decoded_token.id),
            mysql.travel.getTravelIdByDriverId(socket.decoded_token.id)
        ]);
        let RiderConnectionId = await redis.getConnectionId(riderPrefix + riderId);
        io.to(RiderConnectionId).emit('startTravel');
        await mysql.travel.start(travelId, travelTypeId);
    });
    socket.on('finishedTaxi', async function (cost, time, distance, log, callback) {
        let [ignored, riderId, travelId] = await Promise.all([
            mysql.driver.setState(socket.decoded_token.id, DRIVER_STATE_ONLINE),
            mysql.travel.getRiderIdByDriverId(socket.decoded_token.id),
            mysql.travel.getTravelIdByDriverId(socket.decoded_token.id),
        ]);
        let [riderBalance, riderConnectionId, ignored2] = await Promise.all([
            mysql.rider.getBalance(riderId),
            redis.getConnectionId(riderPrefix + riderId),
            mysql.travel.finish(travelId, cost, time, distance, log)
        ]);
        let paid = false;
        if (riderBalance >= cost) {
            let [ignored3, ignored4] = await Promise.all([
                mysql.rider.payMoney(riderId, cost),
                mysql.driver.addCredit(socket.decoded_token.id, (cost * (100 - process.env.PERCENT_FOR_COMPANY)) / 100)]);
            paid = true;
        }
        else if (process.env.CASH_PAYMENT_REDUCES_DRIVER_CREDIT == 'true') {
            await mysql.driver.addCredit(socket.decoded_token.id, (cost * (process.env.PERCENT_FOR_COMPANY / 100)));
        }
        callback(200, paid, cost);
        driverInfoChanged(socket.decoded_token.id);
        riderInfoChanged(riderId);
        io.to(riderConnectionId).emit('finishedTaxi', 200, paid, cost);
    });
    socket.on('cancelTravel', async function (callback) {
        let [ignored, otherPartyId, ignored2] = await Promise.all([
            mysql.travel.setState(socket.decoded_token.connection_prefix == driverPrefix ? mysql.travel.TRAVEL_ERROR_DRIVER_CANCELED : mysql.travel.TRAVEL_ERROR_RIDER_CANCELED),
            socket.decoded_token.connection_prefix == driverPrefix ? mysql.travel.getRiderIdByDriverId(socket.decoded_token.id) : mysql.travel.getDriverIdByRiderId(socket.decoded_token.id),
            mysql.driver.setState(socket.decoded_token.id, DRIVER_STATE_ONLINE)
        ]);
        let connectionId = await redis.getConnectionId((socket.decoded_token.connection_prefix == driverPrefix ? riderPrefix : driverPrefix) + otherPartyId);
        io.to(connectionId).emit('cancelTravel');
        callback(200);
    });
    socket.on('reviewDriver', async function (score, review, callback) {
        let driverId = await mysql.travel.getDriverIdByRiderId(socket.decoded_token.id);
        await Promise.all([mysql.driver.updateScore(driverId, score),
            mysql.driver.saveReview(socket.decoded_token.id, driverId, review, score)]);
        callback(200);
    });
    socket.on('getTravels', async function (callback) {
        let result;
        if (socket.decoded_token.connection_prefix == driverPrefix)
            result = await mysql.travel.getDriverTravelsById(socket.decoded_token.id);
        else
            result = await mysql.travel.getRiderTravelsById(socket.decoded_token.id);
        callback(200, result);
    });
    socket.on('editProfile', async function (user, callback) {
        try {
            if (socket.decoded_token.connection_prefix == driverPrefix)
                await mysql.driver.editProfile(socket.decoded_token.id, user);
            else
                await mysql.rider.editProfile(socket.decoded_token.id, user);
            callback(200);
        }
        catch (err) {
            callback(666);
        }
    });
    socket.on('changeProfileImage', async function (buffer, callback) {
        let fileName;
        if (socket.decoded_token.connection_prefix == driverPrefix)
            fileName = await uploader.doUpload(IMAGE_DRIVER, buffer, socket.decoded_token.id);
        if (socket.decoded_token.connection_prefix == riderPrefix)
            fileName = await uploader.doUpload(IMAGE_RIDER, buffer, socket.decoded_token.id);
        callback(200, fileName);

    });
    socket.on('changeHeaderImage', async function (buffer, callback) {
        if (socket.decoded_token.connection_prefix == driverPrefix) {
            let fileName = await uploader.doUpload(IMAGE_DRIVER_HEADER, buffer, socket.decoded_token.id);
            callback(200, fileName);
        }
    });
    socket.on('getTravelInfo', async function () {
        let driverId = await mysql.travel.getDriverIdByRiderId(socket.decoded_token.id);
        let connectionId = await redis.getConnectionId(driverPrefix + driverId);
        io.to(connectionId).emit('getTravelInfo');
    });
    socket.on('travelInfo', async function (distance, time, cost) {
        let [connectionId, location] = await Promise.all([redis.getConnectionId(riderPrefix + socket.riderId),
            redis.getLocation(driverPrefix + socket.decoded_token.id)]);
        io.to(connectionId).emit('travelInfoReceived', distance, parseInt(time), parseFloat(cost), parseFloat(location.latitude), parseFloat(location.longitude));
    });
    socket.on('getDriversLocation', async function (northeastLat, northeastLng, southwestLat, southwestLng, callback) {
        try {
            let locations = await redis.getLocations(driverPrefix, onlineDrivers);
            const bounds = [
                {latitude: southwestLat, longitude: southwestLng},
                {latitude: southwestLat, longitude: northeastLng},
                {latitude: northeastLat, longitude: northeastLng},
                {latitude: northeastLat, longitude: southwestLng}];
            for (const location of locations) {
                if (!geoLib.isPointInside(location.location, bounds))
                    locations.splice(locations.indexOf(location), 1);
            }
            locations = locations.map(function (item) {
                return {
                    id: item.id,
                    lat: item.location.latitude,
                    lng: item.location.longitude
                };
            });
            callback(200, locations);
        }
        catch (err) {
            callback(404, 0);
        }
    });
    socket.on('chargeAccount', async function (stripeToken, amount, callback) {
        // Charge the user's card:
        stripe.charges.create({
            amount: amount,
            currency: process.env.PAYMENT_CURRENCY,
            source: stripeToken,
        }, async function (err, charge) {
            if (!err) {
                await mysql.rider.chargeAccount(socket.decoded_token.id, amount);
                await riderInfoChanged(socket.decoded_token.id);
                callback(200);
            }
            else {
                callback(err.statusCode, err.message);
            }
        });
    });
    socket.on('getStats', async function (timeQuery, callback) {
        let stats, report;
        switch (timeQuery) {
            case TIME_QUERY_DAILY:
                [stats, report] = await Promise.all(
                    [
                        mysql.driver.getDailyStats(socket.decoded_token.id),
                        mysql.driver.getDailyReport(socket.decoded_token.id)
                    ]);
                break;
            case TIME_QUERY_WEEKLY:
                [stats, report] = await Promise.all(
                    [
                        mysql.driver.getWeeklyStats(socket.decoded_token.id),
                        mysql.driver.getWeeklyReport(socket.decoded_token.id)
                    ]);
                break;

            case TIME_QUERY_MONTHLY:
                [stats, report] = await Promise.all(
                    [
                        mysql.driver.getMonthlyStats(socket.decoded_token.id),
                        mysql.driver.getMonthlyReport(socket.decoded_token.id)
                    ]);
                break;
            default:
                callback(401, '', '');
                break;
        }
        callback(200, stats[0][0], report[0]);
    });

    socket.on('requestPayment', async function (callback) {
        let [pending, driverInfo] = await Promise.all([mysql.payments.driverHasPending(socket.decoded_token.id), mysql.payments.getDriverUnpaidAmount(socket.decoded_token.id)]);
        if (pending[0].length != 0) {
            callback(901);
            return;
        }
        if (driverInfo[0][0].credit < process.env.MINIMUM_AMOUNT_TO_REQUEST_PAYMENT) {
            callback(902);
            return;
        }
        await mysql.payments.requestPayment(socket.decoded_token.id, driverInfo[0][0].credit, driverInfo[0][0].account_number);
        callback(200);
        baseData.unpaid_count++;
        updateBaseData();
    });
    socket.on('hideTravel', async function (travelId, callback) {
        let result = await mysql.travel.hideTravel(travelId);
        if (result)
            callback(200);
        else
            callback(666);
    });
    socket.on('writeComplaint', async function (travelId, subject, content, callback) {
        if (socket.decoded_token.connection_prefix == driverPrefix) {
            await mysql.complaints.driverComplaint(travelId, subject, content);
        }
        if (socket.decoded_token.connection_prefix == riderPrefix) {
            await mysql.complaints.riderComplaint(travelId, subject, content);
        }
        baseData.waiting_complaints++;
        updateBaseData();
        callback(200);
    });

});
process.on('unhandledRejection', r => console.log(r));
server.listen(process.env.MAIN_PORT, function () {
    console.log("Listening on " + process.env.MAIN_PORT);
});