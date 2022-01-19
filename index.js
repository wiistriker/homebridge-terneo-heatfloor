var Service, Characteristic;
const packageJson = require('./package.json');
const axios = require('axios');
const TOTP = require('totp.js');

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    homebridge.registerAccessory('homebridge-terneo-heatfloor', 'TerneoHeatfloor', TerneoHeatfloor);
};

function TerneoHeatfloor(log, config) {
    this.log = log;

    this.name = config.name;
    this.apiroute = 'http://' + config.ip;
    this.pollInterval = config.pollInterval || 60;

    this.manufacturer = 'Terneo';
    this.serial = config.serial;
    this.auth = config.auth || null;
    this.time_offset = config.time_offset || 0;
    this.model = config.model || packageJson.name;
    this.firmware = config.firmware || packageJson.version;

    this.accessory_type = config.accessory_type || 'thermostat';

    this.minTemp = config.minTemp || 5;
    this.maxTemp = config.maxTemp || 40;

    this.debug = config.debug || false;

    let initialize_message = '[Terneo] [INFO] Accessory initialized';
    if (this.debug) {
        initialize_message += ', debug mode enabled';
    }

    this.log(initialize_message);
}

TerneoHeatfloor.prototype = {
    identify: function (callback) {
        //this.log('Identify requested!');
        callback();
    },
    logDebug: function() {
        if (this.debug) {
            this.log.info(...arguments);
        } else {
            this.log.debug(...arguments);
        }
    },
    getServices: function () {
        var services = [];

        var infoService = new Service.AccessoryInformation();
        infoService
            .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
            .setCharacteristic(Characteristic.Model, this.model)
            .setCharacteristic(Characteristic.SerialNumber, this.serial)
            .setCharacteristic(Characteristic.FirmwareRevision, this.firmware)
        ;

        services.push(infoService);

        var heaterService = new Service.HeaterCooler(this.name);

        var lastState = {}, stateUpdatePromise = null, paramsChanges = {}, $commitParamsChangesPromise = null, $commitParamsChangesTimeout = null;

        $scheduleStateUpdatePoll = (timeout) => {
            this.logDebug('[Terneo] [DEBUG] Schedule new state update after ' + (timeout / 1000) + ' sec.');
            $stateUpdatePollTimeout = setTimeout(() => {
                $stateUpdatePollTimeout = null;
                $startStateUpdatePoll();
            }, timeout);
        };

        const $appendParamChange = (param, type, value) => {
            paramsChanges[param] = [type, value];
        };

        const $scheduleParamsChanges = (timeout) => {
            if ($commitParamsChangesTimeout) {
                clearTimeout($commitParamsChangesTimeout);
            }

            this.logDebug('[Terneo] [DEBUG] Schedule param changes after ' + (timeout / 1000) + ' sec.');
            $commitParamsChangesTimeout = setTimeout(() => {
                $commitParamsChangesTimeout = null;
                $commitParamsChanges();
            }, timeout);
        };

        const $commitParamsChanges = () => {
            if ($commitParamsChangesPromise) {
                return $commitParamsChangesPromise;
            }

            var params = [];

            Object.keys(paramsChanges).forEach((param, index) => {
                type_value_pair = paramsChanges[param];
                params.push([ param, type_value_pair[0], type_value_pair[1] ]);
            });

            console.log('Commit param changes with', {
                sn: this.serial,
                par: params
            });

            $commitParamsChangesPromise = axios.post(this.apiroute + '/api.cgi', {
                sn: this.serial,
                par: params
            }, {
                timeout: 3000
            })
                .then((response) => {
                    paramsChanges = {};

                    console.log('Commit param changes response', response.data);

                    if (response.data.success) {
                        //this.log.info('[Terneo] [INFO] Active successfully setted to', value);

                        //lastState['power'] = power_on;
                        $scheduleStateUpdatePoll(1000);
                        //callback();
                    } else {
                        this.log.warn('[Terneo] [WARNING] Active set failure');
                        //callback(new Error('Error during set Active'));
                    }
                })
                .catch((error) => {
                    console.log('Commit param changes error', error);
                    //callback(error)
                })
                .finally(() => {
                    $commitParamsChangesPromise = null;
                })
            ;

            return $commitParamsChangesPromise;
        };

        const $stateUpdate = () => {
            if (stateUpdatePromise) {
                return stateUpdatePromise;
            }

            stateUpdatePromise = axios.post(this.apiroute + '/api.cgi', {
                cmd: 1
            }, {
                timeout: 3000
            })
                .then((response) => {
                    if (response.data && response.data.par) {
                        var state = {}, params = {};
                        response.data.par.forEach((item) => {
                            const param_key = item[0];
                            const param_type = item[1];
                            const param_value = item[2];

                            switch (param_type) {
                                case 1:
                                    var param_value_int = parseInt(param_value);
                                    if (isNaN(param_value_int)) {
                                        param_value_int = -999;
                                    }

                                    params[param_key] = param_value_int;
                                    break;

                                case 7:
                                    params[param_key] = param_value === '1';
                                    break;

                                default:
                                    params[param_key] = param_value;
                                    break;
                            }
                        });

                        state['power'] = !params['125'];
                        state['lock'] = params['124'];

                        return axios.post(this.apiroute + '/api.cgi', {
                            cmd: 4
                        }, {
                            timeout: 3000
                        })
                            .then((response) => {
                                if (response.data['t.1']) {
                                    state['current_temperature'] = response.data['t.1'] / 16;
                                    state['target_temperature'] = response.data['t.5'] / 16;
                                    state['heating'] = response.data['f.0'] === '1';
                                    state['block'] = response.data['m.3'];
                                    state['work_mode'] = response.data['m.1'];

                                    return state;
                                } else {
                                    this.logDebug('cmd:4 response', response.data);
                                    throw new Error('Response has no telemetry data');
                                }
                            })
                        ;
                    } else {
                        this.logDebug('cmd:1 response', response.data);
                        throw new Error('Response has no parameters data');
                    }
                })
                .finally(() => {
                    stateUpdatePromise = null;
                })
            ;

            return stateUpdatePromise;
        };

        var currentTemperatureCharacteristic = heaterService.getCharacteristic(Characteristic.CurrentTemperature);
        var currentHeaterCoolerStateCharacteristic = heaterService.getCharacteristic(Characteristic.CurrentHeaterCoolerState);

        currentHeaterCoolerStateCharacteristic.setProps({
            validValues: [
                Characteristic.CurrentHeaterCoolerState.INACTIVE,
                Characteristic.CurrentHeaterCoolerState.IDLE,
                Characteristic.CurrentHeaterCoolerState.HEATING
            ]
        });

        var targetHeaterCoolerStateCharacteristic = heaterService.getCharacteristic(Characteristic.TargetHeaterCoolerState);
        targetHeaterCoolerStateCharacteristic.setProps({
            validValues: [
                Characteristic.TargetHeaterCoolerState.HEAT
            ]
        });

        var activeCharacteristic = heaterService.getCharacteristic(Characteristic.Active);
        var lockPhysicalControlsCharacteristic = heaterService.addCharacteristic(Characteristic.LockPhysicalControls);

        var temperatureDisplayUnitsCharacteristic = heaterService.addCharacteristic(Characteristic.TemperatureDisplayUnits);
        temperatureDisplayUnitsCharacteristic.setProps({
            validValues: [ Characteristic.TemperatureDisplayUnits.CELSIUS ]
        });

        temperatureDisplayUnitsCharacteristic.setValue(Characteristic.TemperatureDisplayUnits.CELSIUS);

        var heatingThresholdTemperature = heaterService.getCharacteristic(Characteristic.HeatingThresholdTemperature);

        heatingThresholdTemperature
            .setProps({
                minValue: this.minTemp,
                maxValue: this.maxTemp,
                minStep: 1
            })
            .on('get', (callback) => {
                if (typeof lastState['target_temperature'] !== 'undefined') {
                    callback(null, lastState['target_temperature']);
                } else {
                    callback(null, 0);
                }
            })
            .on('set', (value, callback) => {
                this.logDebug('[Terneo] [DEBUG] Set HeatingThresholdTemperature to ' + value + ', type: ' + typeof(value));

                /*
                $appendParamChange(5, 1, value + '');
                $appendParamChange(2, 2, value <= this.minTemp ? '0' : '1');
                $scheduleParamsChanges(300);
                callback();

                return;
                 */

                var params = [
                    [ 5, 1, value + '' ]
                ];

                if (value <= this.minTemp) {
                    params.push([ 2, 2, '0' ]);
                } else {
                    params.push([ 2, 2, '1' ]);
                }

                var post_params = {
                    sn: this.serial
                };

                if (this.auth) {
                    var start = new Date(2000, 0, 1, 0, 0, 0), now = new Date();
                    post_params['time'] = (Math.round((now.getTime() - start.getTime()) / 1000) + this.time_offset) + '';

                    const totp = new TOTP(this.auth, 9);
                    post_params['auth'] = totp.genOTP();
                }

                post_params.par = params;

                //console.log(post_params);

                axios.post(this.apiroute + '/api.cgi', post_params, {
                    timeout: 3000
                })
                    .then((response) => {
                        if (response.data.success) {
                            this.logDebug('[Terneo] [DEBUG] HeatingThresholdTemperature successfully setted to', value);

                            lastState['target_temperature'] = value;
                            $scheduleStateUpdatePoll(1000);
                            callback();
                        } else {
                            this.log.warn('[Terneo] [WARNING] HeatingThresholdTemperature set failure, response:', response.data);
                            callback(new Error('Error during set HeatingThresholdTemperature'));
                        }
                    })
                    .catch((error) => {
                        this.log.warn('[Terneo] [WARNING] HeatingThresholdTemperature set failure', error);
                        callback(error)
                    })
                ;
            })
        ;

        activeCharacteristic
            .on('set', (value, callback) => {
                this.logDebug('[Terneo] [DEBUG] Set Active to ' + value + ', type: ' + typeof(value));

                var power_on;
                if (value === 1) {
                    power_on = true;
                } else if (value === 0) {
                    power_on = false;
                }

                if (power_on !== undefined) {
                    var post_params = {
                        sn: this.serial,
                        par: [
                            [ 125, 7, power_on ? '0' : '1' ]
                        ]
                    };

                    if (this.auth) {
                        post_params['auth'] = this.auth;
                    }

                    axios.post(this.apiroute + '/api.cgi', post_params, {
                        timeout: 3000
                    })
                        .then((response) => {
                            if (response.data.success) {
                                this.log.info('[Terneo] [INFO] Active successfully setted to', value);

                                lastState['power'] = power_on;
                                $scheduleStateUpdatePoll(1000);
                                callback();
                            } else {
                                this.log.warn('[Terneo] [WARNING] Active set failure', response.data);
                                callback(new Error('Error during set Active'));
                            }
                        })
                        .catch((error) => {
                            this.log.warn('[Terneo] [WARNING] Active set failure', error);
                            callback(error)
                        })
                    ;
                } else {
                    callback(new Error('Unknown Active value: ' + value + ' (' + typeof(value) + ')'));
                }
            })
        ;

        lockPhysicalControlsCharacteristic
            .on('set', (value, callback) => {
                this.logDebug('[Terneo] [DEBUG] Set LockPhysicalControls to ' + value + ', type: ' + typeof(value));

                var lock_on;
                if (value === 1) {
                    lock_on = true;
                } else if (value === 0) {
                    lock_on = false;
                }

                if (lock_on !== undefined) {
                    var post_params = {
                        sn: this.serial,
                        par: [
                            [ 124, 7, lock_on ? '1' : '0' ]
                        ]
                    };

                    if (this.auth) {
                        post_params['auth'] = this.auth;
                    }

                    axios.post(this.apiroute + '/api.cgi', post_params, {
                        timeout: 3000
                    })
                        .then((response) => {
                            if (response.data.success) {
                                this.log.info('[Terneo] [INFO] LockPhysicalControls successfully setted to', lock_on);

                                lastState['lock'] = lock_on;
                                $scheduleStateUpdatePoll(1000);
                                callback();
                            } else {
                                this.log.warn('[Terneo] [WARNING] LockPhysicalControls set failure, reponse:', response.data);
                                callback(new Error('Error during set LockPhysicalControls'));
                            }
                        })
                        .catch((error) => {
                            this.log.warn('[Terneo] [WARNING] LockPhysicalControls set failure', error);
                            callback(error)
                        })
                    ;
                } else {
                    callback(new Error('Unknown LockPhysicalControls value: ' + value + ' (' + typeof(value) + ')'));
                }
            })
        ;

        var $stateUpdatePollTimeout = null;

        $scheduleStateUpdatePoll = (timeout) => {
            if ($stateUpdatePollTimeout) {
                clearTimeout($stateUpdatePollTimeout);
            }

            this.logDebug('[Terneo] [DEBUG] Schedule new state update after ' + (timeout / 1000) + ' sec.');
            $stateUpdatePollTimeout = setTimeout(() => {
                $stateUpdatePollTimeout = null;
                $startStateUpdatePoll();
            }, timeout);
        };

        $startStateUpdatePoll = () => {
            this.logDebug('[Terneo] [DEBUG] Begin state update');

            $stateUpdate()
                .then((state) => {
                    this.logDebug('[Terneo] [DEBUG] State successfully updated');

                    if (state['power'] !== lastState['power']) {
                        this.logDebug('[Terneo] [DEBUG] Active change:', state['power'], '/', lastState['power']);
                        activeCharacteristic.updateValue(state['power'] ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
                    }

                    if (state['lock'] !== lastState['lock']) {
                        this.logDebug('[Terneo] [DEBUG] lock change:', state['lock'], '/', lastState['lock']);
                        lockPhysicalControlsCharacteristic.updateValue(state['lock'] ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED);
                    }

                    if (state['current_temperature'] !== lastState['current_temperature']) {
                        this.logDebug('[Terneo] [DEBUG] CurrentTemperatureCharacteristic change:', state['current_temperature'], '/', lastState['current_temperature']);
                        currentTemperatureCharacteristic.updateValue(state['current_temperature']);
                    }

                    if (state['target_temperature'] !== lastState['target_temperature']) {
                        this.logDebug('[Terneo] [DEBUG] HeatingThresholdTemperature change:', state['target_temperature'], '/', lastState['target_temperature']);
                        heatingThresholdTemperature.updateValue(state['target_temperature']);
                    }

                    if (state['heating'] !== lastState['heating']) {
                        this.logDebug('[Terneo] [DEBUG] heating change:', state['heating'], '/', lastState['heating']);
                        if (state['heating']) {
                            currentHeaterCoolerStateCharacteristic.updateValue(Characteristic.CurrentHeaterCoolerState.HEATING);
                            //targetHeaterCoolerStateCharacteristic.updateValue(Characteristic.TargetHeaterCoolerState.HEAT);
                        } else {
                            currentHeaterCoolerStateCharacteristic.updateValue(Characteristic.CurrentHeaterCoolerState.INACTIVE);
                            //targetHeaterCoolerStateCharacteristic.updateValue(undefined);
                        }
                    }

                    if (state['work_mode'] !== lastState['work_mode']) {
                        //var updated_name = this.name;
                        this.logDebug('[Terneo] [DEBUG] work_mode change:', state['work_mode'], '/', lastState['work_mode']);
                    }

                    switch (state['block']) {
                        case '2':
                        case '3':
                            this.log.error('[Terneo] [ERROR] BLOCK ENABLED! Please turn off local api blocking!');
                            break;
                    }

                    lastState = state;
                })
                .catch((error) => {
                    this.log.warn('[Terneo] [WARNING] State update error', error);
                })
                .finally(() => {
                    $scheduleStateUpdatePoll(this.pollInterval * 1000);
                })
            ;
        };

        $startStateUpdatePoll();

        targetHeaterCoolerStateCharacteristic.setValue(Characteristic.TargetHeaterCoolerState.HEAT);

        services.push(heaterService);

        return services;
    }
};