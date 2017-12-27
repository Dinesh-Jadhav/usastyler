const RESULT_OK = 200;
function getRequestIds(searchTerm, sort, pageSize, pageStart) {
    return new Promise(function (resolve, reject) {
        socket.emit('getRequestIds', searchTerm, sort, pageSize, pageStart, function (result) {
            resolve(result);
        });
    });
}
function getRequests(searchTerm, sort, pageSize, pageStart) {
    return new Promise(function (resolve, reject) {
        socket.emit('getRequests', searchTerm, sort, pageSize, pageStart, function (result) {
            resolve(result);
        });
    });
}
function getTableIds(tableName, searchTerm, sort, from, pageSize) {
    return new Promise(function (resolve, reject) {
        socket.emit('getTableIds', tableName, searchTerm, sort, from, pageSize, function (result) {
            resolve(result);
        });
    });
}
function getTableRows(tableName, Ids) {
    return new Promise(function (resolve, reject) {
        socket.emit('getTableRows', tableName, Ids, function (result) {
            resolve(result);
        });
    });
}
function setColumnValue(tableName, id, column, value) {
    return new Promise(function (resolve, reject) {
        socket.emit('setColumnValue', tableName, id, column, value, function (result) {
            resolve(result);
        });
    });
}
function getAllComplaints(searchTerm, sort, from, pageSize, isReviewed) {
    return new Promise(async function (resolve, reject) {
        socket.emit('getAllComplaints', searchTerm, sort, from, pageSize, isReviewed, function (result) {
            resolve(result);
        });
    });
}
function getAllPaymentRequests(searchTerm, sort, from, pageSize, isPaid) {
    return new Promise(async function (resolve, reject) {
        socket.emit('getAllPaymentRequests', searchTerm, sort, from, pageSize, isPaid, function (result) {
            resolve(result);
        });
    });
}
function getAllDrivers(searchTerm, sort, from, pageSize) {
    return new Promise(async function (resolve, reject) {
        socket.emit('getAllDrivers', searchTerm, sort, from, pageSize, function (result) {
            resolve(result);
        });
    });
}
function getBaseTypes(type, sort, from, pageSize) {
    return new Promise(async function (resolve, reject) {
        socket.emit('getBaseTypes', type, sort, from, pageSize, function (result) {
            resolve(result);
        });
    });
}
function getAllOperators(sort, from, pageSize) {
    return new Promise(async function (resolve, reject) {
        socket.emit('getAllOperators', sort, from, pageSize, function (result) {
            resolve(result);
        });
    });
}
function getAllTravels(searchTerm, sort, from, pageSize) {
    return new Promise(async function (resolve, reject) {
        socket.emit('getAllTravels', searchTerm, sort, from, pageSize, function (result) {
            resolve(result);
        });
    });
}
function getCallRequests(from, pageSize) {
    return new Promise(async function (resolve, reject) {
        socket.emit('getCallRequests', from, pageSize, function (result) {
            resolve(result);
        });
    });
}
function markComplaintsReviewed(Ids) {
    return new Promise(async function (resolve, reject) {
        socket.emit('markComplaintsReviewed', Ids, function (result) {
            if (result === 200)
                resolve();
            else
                reject();
        });
    })
}