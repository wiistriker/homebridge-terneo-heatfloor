var Service, Characteristic;
const packageJson = require('./package.json');
const axios = require('axios');

module.exports = function(homebridge) {
	Service = homebridge.hap.Service;
  	Characteristic = homebridge.hap.Characteristic;

  	homebridge.registerAccessory('terneo-heatfloor', 'TerneoHeatfloor', TerneoHeatfloor);
};

function TerneoHeatfloor(log, config) {
	this.log = log;

	this.name = config.name;
	this.apiroute = 'http://' + config.ip;
	this.pollInterval = config.pollInterval || 60;

	this.manufacturer = 'Terneo';
	this.serial = config.serial;
	this.model = config.model || packageJson.name;
	this.firmware = config.firmware || packageJson.version;

	this.accessory_type = config.accessory_type || 'thermostat';

    this.minTemp = config.minTemp || 5;
	this.maxTemp = config.maxTemp || 40;
}

TerneoHeatfloor.prototype = {
    identify: function (callback) {
        //this.log('Identify requested!');
        callback()
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

        var lastState = {}, stateUpdatePromise = null;

        const $stateUpdate = () => {
            if (stateUpdatePromise) {
                return stateUpdatePromise;
            }

            stateUpdatePromise = axios.post(this.apiroute + '/api.cgi', {
                cmd: 1
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
                                    throw new Error('Response has no telemetry data');
                                }
                            })
                        ;
                    } else {
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
                    callback(null, null);
                }
            })
            .on('set', (value, callback) => {
                this.log.info('[Terneo] [DEBUG] Set HeatingThresholdTemperature to ' + value + ', type: ' + typeof(value));

                var params = [
                    [ 5, 1, value + '' ]
                ];

                if (value <= this.minTemp) {
                    params.push([ 2, 2, '0' ]);
                } else {
                    params.push([ 2, 2, '1' ]);
                }

                axios.post(this.apiroute + '/api.cgi', {
                    sn: this.serial,
                    par: params
                })
                    .then((response) => {
                        if (response.data.success) {
                            this.log.info('[Terneo] [DEBUG] HeatingThresholdTemperature successfully setted to', value);

                            lastState['target_temperature'] = value;
                            $startStateUpdatePoll();
                            callback();
                        } else {
                            this.log.warn('[Terneo] [WARNING] HeatingThresholdTemperature set failure');
                            callback(new Error('Error during set HeatingThresholdTemperature'));
                        }
                    })
                    .catch((error) => {
                        callback(error)
                    })
                ;
            })
        ;

        activeCharacteristic
            .on('set', (value, callback) => {
                this.log.info('[Terneo] [DEBUG] Set Active to ' + value + ', type: ' + typeof(value));

                var power_on;
                if (value === 1) {
                    power_on = true;
                } else if (value === 0) {
                    power_on = false;
                }

                if (power_on !== undefined) {
                    axios.post(this.apiroute + '/api.cgi', {
                        sn: this.serial,
                        par: [
                            [ 125, 7, power_on ? '0' : '1' ]
                        ]
                    })
                        .then((response) => {
                            if (response.data.success) {
                                this.log.info('[Terneo] [DEBUG] Active successfully setted to', value);

                                lastState['power'] = power_on;
                                $startStateUpdatePoll();
                                callback();
                            } else {
                                this.log.warn('[Terneo] [WARNING] Active set failure');
                                callback(new Error('Error during set Active'));
                            }
                        })
                        .catch((error) => {
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
                this.log.info('[Terneo] [DEBUG] Set LockPhysicalControls to ' + value + ', type: ' + typeof(value));

                var lock_on;
                if (value === 1) {
                    lock_on = true;
                } else if (value === 0) {
                    lock_on = false;
                }

                if (lock_on !== undefined) {
                    axios.post(this.apiroute + '/api.cgi', {
                        sn: this.serial,
                        par: [
                            [ 124, 7, lock_on ? '1' : '0' ]
                        ]
                    })
                        .then((response) => {
                            if (response.data.success) {
                                this.log.info('[Terneo] [DEBUG] LockPhysicalControls successfully setted to', lock_on);

                                lastState['lock'] = lock_on;
                                $startStateUpdatePoll();
                                callback();
                            } else {
                                this.log.warn('[Terneo] [WARNING] LockPhysicalControls set failure');
                                callback(new Error('Error during set LockPhysicalControls'));
                            }
                        })
                        .catch((error) => {
                            callback(error)
                        })
                    ;
                } else {
                    callback(new Error('Unknown LockPhysicalControls value: ' + value + ' (' + typeof(value) + ')'));
                }
            })
        ;

        var $stateUpdatePollTimeout = null;
        $startStateUpdatePoll = () => {
            this.log.info('[Terneo] [DEBUG] Begin state update');

            if ($stateUpdatePollTimeout) {
                clearTimeout($stateUpdatePollTimeout);
            }

            $stateUpdate()
                .then((state) => {
                    this.log.info('[Terneo] [DEBUG] State successfully updated');

                    if (state['power'] !== lastState['power']) {
                        this.log.info('[Terneo] [DEBUG] Active change:', state['power'], '/', lastState['power']);
                        activeCharacteristic.updateValue(state['power'] ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
                    }

                    if (state['lock'] !== lastState['lock']) {
                        this.log.info('[Terneo] [DEBUG] lock change:', state['lock'], '/', lastState['lock']);
                        lockPhysicalControlsCharacteristic.updateValue(state['lock'] ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED);
                    }

                    if (state['current_temperature'] !== lastState['current_temperature']) {
                        this.log.info('[Terneo] [DEBUG] CurrentTemperatureCharacteristic change:', state['current_temperature'], '/', lastState['current_temperature']);
                        currentTemperatureCharacteristic.updateValue(state['current_temperature']);
                    }

                    if (state['target_temperature'] !== lastState['target_temperature']) {
                        this.log.info('[Terneo] [DEBUG] HeatingThresholdTemperature change:', state['target_temperature'], '/', lastState['target_temperature']);
                        heatingThresholdTemperature.updateValue(state['target_temperature']);
                    }

                    if (state['heating'] !== lastState['heating']) {
                        this.log.info('[Terneo] [DEBUG] heating change:', state['heating'], '/', lastState['heating']);
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
                        this.log.info('[Terneo] [DEBUG] work_mode change:', state['work_mode'], '/', lastState['work_mode']);
                    }

                    switch (state['block']) {
                        case '2':
                        case '3':
                            this.log.error('[Terneo] [ERROR] Block enabled! Please turn off local api blocking!');
                            break;
                    }

                    lastState = state;
                })
                .catch((error) => {
                    this.log.warn('[Terneo] [WARNING] State update error', error);
                })
                .finally(() => {
                    this.log.info('[Terneo] [DEBUG] Schedule new state update after ' + this.pollInterval + ' sec.');
                    $stateUpdatePollTimeout = setTimeout(() => {
                        $stateUpdatePollTimeout = null;
                        $startStateUpdatePoll();
                    }, this.pollInterval * 1000);
                })
            ;
        };

        $startStateUpdatePoll();

        targetHeaterCoolerStateCharacteristic.setValue(Characteristic.TargetHeaterCoolerState.HEAT);

        services.push(heaterService);

        return services;
    }
};