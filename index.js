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

	this.manufacturer = config.manufacturer || packageJson.author.name;
	this.serial = config.serial;
	this.model = config.model || packageJson.name;
	this.firmware = config.firmware || packageJson.version;

    this.minTemp = config.minTemp || 5;
	this.maxTemp = config.maxTemp || 40;
}

TerneoHeatfloor.prototype = {
    identify: function (callback) {
        //this.log('Identify requested!');
        callback()
    },
    getServices: function () {
        var $this = this;
        var services = [];

        var infoService = new Service.AccessoryInformation();
        infoService
            .setCharacteristic(Characteristic.Manufacturer, $this.manufacturer)
            .setCharacteristic(Characteristic.Model, $this.model)
            .setCharacteristic(Characteristic.SerialNumber, $this.serial)
            .setCharacteristic(Characteristic.FirmwareRevision, $this.firmware)
        ;

        services.push(infoService);

        var heaterService = new Service.HeaterCooler($this.name);

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

                        this.log("Terneo cmd:1 response: ", params);

                        state["power"] = !params['125'];
                        state["lock"] = params[124];

                        return axios.post(this.apiroute + '/api.cgi', {
                            cmd: 4
                        })
                            .then((response) => {
                                //this.log(response.data);
                                this.log("Terneo cmd:4 response: ", response);

                                if (response.data['t.1']) {
                                    state['current_temperature'] = response.data['t.1'] / 16;
                                    state['target_temperature'] = response.data['t.5'] / 16;
                                    state['heating'] = response.data['f.0'] === '1';

                                    return state;
                                } else {
                                    throw new Error('Response has no temperature');
                                    //this.log.error("Error getting temperature from response");
                                }
                            })
                        ;
                    } else {
                        throw new Error('Response has no data');
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
        temperatureDisplayUnitsCharacteristic.setValue(Characteristic.TemperatureDisplayUnits.CELSIUS);
        temperatureDisplayUnitsCharacteristic.setProps({
            validValues: [ 0 ]
        });

        var heatingThresholdTemperature = heaterService.getCharacteristic(Characteristic.HeatingThresholdTemperature);

        heatingThresholdTemperature
            .setProps({
                minValue: $this.minTemp,
                maxValue: $this.maxTemp,
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
                this.log.info('[Terneo][DEBUG] (' + this.serial + ') HeatingThresholdTemperature - set: ' + value + ', type: ' + typeof(value));

                var params = [
                    [ 5, 1, value + '' ]
                ];

                if (value <= this.minTemp) {
                    params.push([ 2, 2, '0' ]);
                } else {
                    params.push([ 2, 2, '1' ]);
                }

                //this.log(params);

                axios.post(this.apiroute + '/api.cgi', {
                    sn: this.serial,
                    par: params
                })
                    .then((response) => {
                        this.log.info('[Terneo][DEBUG] (' + this.serial + ') HeatingThresholdTemperature - set response', response);

                        if (response.data.success) {
                            lastState['target_temperature'] = value;
                            $startStateUpdatePoll();
                            callback();
                        } else {
                            callback(new Error('Not success'));
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
                this.log.info('[Terneo][DEBUG] (' + this.serial + ') activeCharacteristic - set: ' + value + ', type: ' + typeof(value));

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
                            //this.log(response.data);
                            this.log.info('[Terneo][DEBUG] (' + this.serial + ') activeCharacteristic set response', response);

                            if (response.data.success) {
                                lastState['power'] = power_on;
                                $startStateUpdatePoll();
                                callback();
                            } else {
                                callback(new Error('Not success'));
                            }
                        })
                        .catch((error) => {
                            callback(error)
                        })
                    ;
                } else {
                    callback(new Error('Unknown active value: ' + value + ' (' + typeof(value) + ')'));
                }
            })
        ;

        lockPhysicalControlsCharacteristic
            .on('set', (value, callback) => {
                this.log.info('[Terneo][DEBUG] (' + this.serial + ') lockPhysicalControlsCharacteristic - set: ' + value + ', type: ' + typeof(value));

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
                            this.log.info('[Terneo][DEBUG] (' + this.serial + ') lockPhysicalControlsCharacteristic set response', response);
                            if (response.data.success) {
                                lastState['lock'] = lock_on;
                                $startStateUpdatePoll();
                                callback();
                            } else {
                                callback(new Error('Not success'));
                            }
                        })
                        .catch((error) => {
                            callback(error)
                        })
                    ;
                } else {
                    callback(new Error('Unknown lock value: ' + value + ' (' + typeof(value) + ')'));
                }
            })
        ;

        var $stateUpdatePollTimeout = null;
        $startStateUpdatePoll = () => {
            this.log.info('[Terneo][DEBUG] (' + this.serial + ') State update');

            if ($stateUpdatePollTimeout) {
                clearTimeout($stateUpdatePollTimeout);
            }

            $stateUpdate()
                .then((state) => {
                    if (state['power'] !== lastState['power']) {
                        this.log.info('[Terneo][DEBUG] (' + this.serial + ') Active change: ' + state['power']);
                        activeCharacteristic.updateValue(state['power'] ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
                    }

                    if (state['lock'] !== lastState['lock']) {
                        this.log.info('[Terneo][DEBUG] (' + this.serial + ') LockPhysicalControlsCharacteristic change: ' + state['lock']);
                        lockPhysicalControlsCharacteristic.updateValue(state[124] ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED);
                    }

                    if (state['current_temperature'] !== lastState['current_temperature']) {
                        this.log.info('[Terneo][DEBUG] (' + this.serial + ') CurrentTemperatureCharacteristic change: ' + state['current_temperature']);
                        currentTemperatureCharacteristic.updateValue(state['current_temperature']);
                    }

                    if (state['target_temperature'] !== lastState['target_temperature']) {
                        this.log.info('[Terneo][DEBUG] (' + this.serial + ') HeatingThresholdTemperature change: ' + state['target_temperature']);
                        heatingThresholdTemperature.updateValue(state['target_temperature']);
                    }

                    if (state['heating'] !== lastState['heating']) {
                        this.log.info('[Terneo][DEBUG] (' + this.serial + ') currentHeaterCoolerStateCharacteristic change: ' + state['heating']);
                        if (state['heating']) {
                            currentHeaterCoolerStateCharacteristic.updateValue(Characteristic.CurrentHeaterCoolerState.HEATING);
                            //targetHeaterCoolerStateCharacteristic.updateValue(Characteristic.TargetHeaterCoolerState.HEAT);
                        } else {
                            currentHeaterCoolerStateCharacteristic.updateValue(Characteristic.CurrentHeaterCoolerState.INACTIVE);
                            //targetHeaterCoolerStateCharacteristic.updateValue(undefined);
                        }
                    }

                    lastState = state;
                })
                .catch((error) => {
                    this.log.info('[Terneo][DEBUG] (' + this.serial + ') State update error', error);
                })
                .finally(() => {
                    this.log.info('[Terneo][DEBUG] (' + this.serial + ') Schedule new state update after ' + this.pollInterval + ' sec.');
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