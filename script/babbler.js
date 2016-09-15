
/** Ждем ответ не более 5ти секунд, потом игнорируем */
const BBLR_REPLY_TIMEOUT_MILLIS = 5000;

/** Статусы устройства: отключено, подключаемся, подключено */
const BBLR_STATUS_DISCONNECTED = "disconnected";
const BBLR_STATUS_CONNECTING = "connecting";
const BBLR_STATUS_CONNECTED = "connected";

/** Ошибка команды: таймаут */
const BBLR_ERROR_REPLY_TIMEOUT = "Reply timeout";
/** Ошибка команды: устройство отключено в процессе выполненияы */
const BBLR_ERROR_DISCONNECTED = "Disconnected";
/** Ошибка команды: устройство не подключено */
const BBLR_ERROR_DEVICE_NOT_CONNECTED = "Device not connected"

/** Неправильное имя порта устройства */
const BBLR_ERROR_INVALID_PORT_NAME = "Invalid port name"

/** Команда ping */
const BBLR_CMD_PING = "ping";

/**
 * Создать экземпляр устройства - плата с прошивкой на основе библиотеки Babbler_h, 
 * подключенная через последовательный порт.
 * 
 * https://github.com/1i7/babbler_h
 *
 * @param onStatusChange колбэк для получения обновлений статуса подключения к устройству.
 *     параметры: status - статус подключения: disconnected, connecting, connected
 */
function BabblerDevice(onStatusChange) {
    //http://phrogz.net/js/classes/OOPinJS.html
    
    /** Статус подалкючения к устройству */
    var _deviceStatus = BBLR_STATUS_DISCONNECTED;
    /** Значение ошибки на случай неудачного подключения */
    var _deviceError = undefined;
    
    var _onStatusChange = [onStatusChange];

    /** Последовательный порт */
    var port = undefined;
    
    /** Очередь команд на отправку */
    var cmdQueue = [];
    
    /**
     * Очередь колбэков для ответов на отправленные команды
     * (по-хорошему, там всегда будет максимум один элемент, если контроллер отвечает
     * достаточно быстро)
     */
    var cmdReplyCallbackQueue = [];
    
    /** Счетчик для генерации идентификаторов отправляемых команд */
    var cmdId = 0;
    
    
    /** на всякий случай прочищаем зависшие запросы раз в секунду */
    var validateIntId;
        
    /** 
     * отправлять команду на устройство раз в 200 миллисекунд (5 раз в секунду)
     * (на 100 миллисекундах команды начинают склеиваться)
     */
    var dequeueIntId;
    
    /** проверять статус устройства раз в 5 секунд */
    var checkAliveIntId;
    
    /**
     * Вычистить колбэки, которые ожидают в очереди дольше установленного таймаута
     * BBLR_REPLY_TIMEOUT_MILLIS (5ти секунд)
     */
    var _validateReplyCallbacks = function() {
        // 
        var toRemove = [];
        for(var i in cmdReplyCallbackQueue) {
            var callback = cmdReplyCallbackQueue[i];
            if(Date.now() - callback.timestamp > BBLR_REPLY_TIMEOUT_MILLIS) {
                toRemove.push(callback);
            }
        }
        for(var i in toRemove) {
            var callback = toRemove[i];
            cmdReplyCallbackQueue.splice(cmdReplyCallbackQueue.indexOf(callback), 1);
            callback.onError(callback.cmd, BBLR_ERROR_REPLY_TIMEOUT);
        }
    }
    
    /**
     * Проверить, живо ли устройство: если ответило на ping во-время, значит живо,
     * иначе не живо - отключаемся.
     */
    var _checkDeviceAlive = function() {
        _queueCmd(cmd=BBLR_CMD_PING, params=[],
            // onReply
            onReply=function(cmd, id, reply) {
                // как минимум для последовательного порта
                // здесь это делать не обязательно, т.к.
                // статус "включено" отлавливается в 
                // процессе подключения самого порта
                //_setDeviceStatus(BBLR_STATUS_CONNECTED);
            },
            // onError
            onError=function(cmd, msg) {
                _disconnect(msg);
            }
        );
    }
    
    /**
     * Установить статус устройства: отключено, подключено, подключаемся.
     */
    var _setDeviceStatus = function(status, error) {
        _deviceError = error;
        if(_deviceStatus != status) {
            _deviceStatus = status;
            for(var i in _onStatusChange) {
                var onStatusChange = _onStatusChange[i];
                if(onStatusChange != undefined) {
                    onStatusChange(status);
                }
            }
        }
    }
    
   /** 
    * Добавить слушателя событий устройства
    * @param onStatusChange
    *     параметры: status - статус подключения: disconnected, connecting, connected 
    */
    this.addOnStatusChangeListener = function(onStatusChange) {
        if(onStatusChange != undefined) {
            _onStatusChange.push(onStatusChange);
        }
    }
    
   /** 
    * Удалить слушателя событий устройства
    */
    this.removeOnStatusChangeListener = function(onStatusChange) {
        var index = _onStatusChange.indexOf(onStatusChange);
        if(index != -1) {
            _onStatusChange.splice(index, 1);
        }
    }

    /**
     * Подключаемся к устройству на последовательном порте
     */
    this.connect = function(portName, onData, onDataParseError) {
        // не будем подключаться, если уже подключены
        if(_deviceStatus !== BBLR_STATUS_DISCONNECTED) return;
        
        // подключаемся
        _setDeviceStatus(BBLR_STATUS_CONNECTING);
    
        // некорректное имя порта - засчитаем попытку подключения с ошибкой
        // проверка на пустую строку: true, если undefined, null, 0, "", " ")
        // http://stackoverflow.com/questions/5515310/is-there-a-standard-function-to-check-for-null-undefined-or-blank-variables-in/21732631#21732631
        if((portName ? portName.trim().length == 0 : true)) {
            _setDeviceStatus(BBLR_STATUS_DISCONNECTED, BBLR_ERROR_INVALID_PORT_NAME + ": '" + portName + "'");
            return;
        }
        
        // https://github.com/EmergingTechnologyAdvisors/node-serialport#usage
        var SerialPort = require('serialport');

        port = new SerialPort(portName, {
            // скорость
            baudRate: 9600,
            // получать данные по одной строке
            parser: SerialPort.parsers.readline('\n'),
            // не открывать порт сразу здесь
            autoOpen: false,
            lock: true
        });

        // 
        // События
        // 

        // порт открылся
        port.on('open', function () {
            // порт открыт, но устройство может еще какое-то время тупить 
            // до того, как начнет отвечать на запросы (или это может быть
            // вообще неправильное устройство)
             
            // поэтому будем считать, что подключены, только после того, 
            // как примем ответ на первый пинг
            
            // прочищаем зависшие запросы раз в секунду
            validateIntId = setInterval(_validateReplyCallbacks, 1000);
            
            // отправляем пинг напрямую, а не через очередь команд, т.к. 
            // очередь в этот момент все равно пустая и не работает
            var firstPing = function() {
                _writeCmd(cmd = "ping", params = [],
                    // onReply 
                    onReply = function() {
                        // пришел ответ - теперь точно подключены
                        
                        // отправлять команду на устройство раз в 200 миллисекунд (5 раз в секунду)
                        // (на 100 миллисекундах команды начинают склеиваться)
                        dequeueIntId = setInterval(_dequeueCmd, 200);
                        
                        // проверять статус устройства раз в 5 секунд
                        // (при подключении через последовательный порт - это излишество,
                        // если только обрабатывать случай, когда само устройство повисло
                        // на какую-нибудь долгую задачу и не хочет отправлять ответы в 
                        // установленное время)
                        //checkAliveIntId = setInterval(_checkDeviceAlive, 5000);
                        
                        // обновим статус (на самом деле, устройство может еще 
                        // какое-то время тупить до того, как начнет отвечать
                        // на запросы)
                        _setDeviceStatus(BBLR_STATUS_CONNECTED);
                    },
                    // onError 
                    onError = function(cmd, msg) {
                        // превышено врем ожидаения ответа - пробуем еще раз до 
                        // тех пор, пока не подключимся или не отменим попытки
                        if(_deviceStatus === BBLR_STATUS_CONNECTING && msg === BBLR_ERROR_REPLY_TIMEOUT) {
                            firstPing();
                        }
                    }
                );
            }
            firstPing();
        });

        // пришли данные
        port.on('data', function(data) {
            if(onData != undefined) {
                onData(data);
            }
            
            // ожидаем строку в формате JSON вида
            // {"cmd": "cmd_name", "id": "cmd_id", "reply": "reply_value"}
            var cmdReply = null;
            try {
                // парсим строку в объект
                cmdReply = JSON.parse(data);
            } catch(e) {
                if(onDataParseError != undefined) {
                    onDataParseError(data, e);
                }
            }
            
            if(cmdReply != null) {
                // найдем колбэк по id отправленной команды
                for(var i in cmdReplyCallbackQueue) {
                    var callback = cmdReplyCallbackQueue[i];
                    if(callback.id == cmdReply.id) {
                        cmdReplyCallbackQueue.splice(i, 1);
                        // отправим ответ тому, кто вопрошал
                        if(callback.onReply != undefined) {
                            callback.onReply(callback.cmd, callback.id, cmdReply.reply);
                        }
                        break;
                    }
                }
            }
        });
        
        // отключили устройство (выдернули провод)
        port.on('disconnect', function () {
            _disconnect("Device unplugged");
        });

        // 
        // Действия
        //

        // открываем порт
        port.open(function(err) {
            if(err) {
                // не получилось открыть порт
                
                // обновим статус
                _setDeviceStatus(BBLR_STATUS_DISCONNECTED, err);
            }
        });
    }
    
    /**
     * Отключиться от устройства
     */
    var _disconnect = function (errorMsg) {
        // сначала сообщаем всем, чтобы 
        // больше не дергали устройство
        _setDeviceStatus(BBLR_STATUS_DISCONNECTED, errorMsg);
        
        // дальше спокойно зачищаем ресурсы
    
        // останавливаем все таймеры
        if(validateIntId != undefined) {
            clearInterval(validateIntId);
            validateIntId = undefined;
        }
        if(dequeueIntId != undefined) {
            clearInterval(dequeueIntId);
            dequeueIntId = undefined;
        }
        if(checkAliveIntId != undefined) {
            clearInterval(checkAliveIntId);
            checkAliveIntId = undefined;
        }
        
        // ожидающие ответа - возвращаем ошибки
        for(var i in cmdReplyCallbackQueue) {
            var callback = cmdReplyCallbackQueue[i];
            callback.onError(callback.cmd, BBLR_ERROR_DISCONNECTED);
        }
        cmdReplyCallbackQueue = [];
        
        // обнуляем команды в очереди на отправку -
        // возвращаем ошибки
        for(var i in cmdQueue) {
            var cmd = cmdQueue[i];
            cmd.onError(cmd.cmd, BBLR_ERROR_DISCONNECTED);
        }
        cmdQueue = [];
        
        // закрываем порт
        if(port != undefined && !port.paused) {
            port.close(function(err) {
                // ошибки ловим, но игнорируем
                //console.log(err);
            });
        }
        port = undefined;
    }
    
    /**
     * Отключиться от устройства.
     */
    this.disconnect = _disconnect;
    
    /**
     * Отправить команду на устройство.
     * onReply(cmd, reply)
     * onError(cmd, errorMsg)
     */
    var _writeCmd = function(cmd, params, onReply, onError) {
        // отправляем команду напрямую на устройство
        if(port != undefined && !port.paused) {
            cmdId++;
            // добавим колбэк на получение ответа в очередь
            cmdReplyCallbackQueue.push({
                cmd: cmd,
                id: cmdId.toString(),
                timestamp: Date.now(),
                params: params,
                onReply: onReply,
                onError: onError
            });
                        
            // пишем данные здесь, результат получаем в колбэке на событие data
            port.write(
                JSON.stringify({
                    cmd: cmd,
                    id: cmdId.toString(),
                    params: params
                }), 
                function(err) {
                    if(err) {
                        // ошибка записи в порт - отключаемся
                        // (например, порт открыт, но не хватает прав на запись) 
                        _disconnect("Error writing to port: " + err);
                        // персональная ошибка в onError прилетит из _disconnect
                        //onError(cmd, "Error writing to port: " + err);
                    }
                }
            );
        } else {
            // порт вообще-то не открыт или устройство отключено - отключаемся
            // (вообще, это не должно произойти, т.к. мы ловим событие port 'disconnect')
            _disconnect(BBLR_ERROR_NOT_CONNECTED);
            // персональная ошибка в onError прилетит из _disconnect
            //onError(cmd, "Device not connected");
        }
    }
    
    /**
     * Добавить команду в очередь на отправку на устройство.
     */
    var _queueCmd = function(cmd, params, onReply, onError) {
        // не добавляем новые команды, если не подключены к устройству
        if(_deviceStatus === BBLR_STATUS_CONNECTED) {
            cmdQueue.push({
                cmd: cmd,
                params: params,
                onReply: onReply,
                onError: onError
            });
        } else {
            onError(cmd, BBLR_ERROR_NOT_CONNECTED);
        }
    }
    
    /**
     * Извлечь команду из очереди на отправку на устройство
     * и отправить на устройство.
     */
    var _dequeueCmd = function() {
        // для информации:
        // мы сюда попадем только в том случае, если статус === connected,
        // в других случаях, во-первых не попадем, во-вторых, очередь на отправку
        // все равно будет пуста:
        // 1) таймер для _dequeueCmd запускается только после подключения
        // 2) даже если бы таймер работал все время, в момент подключения
        // список команд пуст (до этого момента их нельзя добавлять - не сработает
        // _queueCmd, а все старые команды вычищаются с ошибкой вызовом disconnect)
        
        var cmd = cmdQueue.shift();
        if(cmd != undefined) {
            _writeCmd(cmd.cmd, cmd.params, cmd.onReply, cmd.onError);
        }
    }
    
    /**
     * Выполнить команду на устройстве. 
     * Параметры: cmd, params, onReply, onError.
     *
     * Команда сначала добавляется во внутреннюю очередь отправки,
     * потом отправляется на устройство. Ответ приходит в колбэк onReply.
     * Если команда отправлена, но ответ не получен дольше, чем установленный
     * таймаут BBLR_REPLY_TIMEOUT_MILLIS (5 секунд), команда считается не выполненной,
     * вызывается колбэк onError со статусом "timeout".
     * 
     * @param cmd - имя команды, строка
     * @param params - параметры, массив строк
     * @param onReply - колбэк на приход ответа
     *     параметры: cmd, id, reply
     * @param onError - колбэк на ошибку (команда не отправлена или ответ не пришел 
     *         в установленное время)
     *     параметры: cmd, msg
     *     
     */
    this.sendCmd = _queueCmd;
    
    /**
     * Текущий статус устройства: не подключено, подключаемся, подключено.
     */
    this.deviceStatus = function() {
        return _deviceStatus;
    }
    
    /**
     * Ошибка устройства (почему не получилось подключиться), если есть.
     */
    this.deviceError = function() {
        return _deviceError;
    }
}


