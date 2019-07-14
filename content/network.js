/*
 * This file is part of EAS-4-TbSync.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. 
 */
 
 "use strict";

var network = {  
    
  getAuthData: function(accountData) {
      let connection = {
          get protocol() { 
            return (accountData.getAccountProperty("https") == "1") ? "https://" : "http://" 
          },
          
          set host(newHost) {
            accountData.setAccountProperty("host", newHost); 
          },
          
          get host() { 
              let h = this.protocol + accountData.getAccountProperty("host"); 
              while (h.endsWith("/")) { h = h.slice(0,-1); }

              if (h.endsWith("Microsoft-Server-ActiveSync")) return h;
              return h + "/Microsoft-Server-ActiveSync"; 
          },
          
          get user() {
            return accountData.getAccountProperty("user");
          },
          
          get password() {
            return tbSync.passwordManager.getLoginInfo(this.host, "TbSync/EAS", this.user);
          },
          
          updateLoginData: function(newUsername, newPassword) {
            let oldUsername = this.user;
            tbSync.passwordManager.updateLoginInfo(this.host, "TbSync/EAS", oldUsername, newUsername, newPassword);
            // Also update the username of this account. Add dedicated username setter?
            accountData.setAccountProperty("user", newUsername);
          },          
      };
      return connection;
  },  

sendRequest: function (wbxml, command, syncData, allowSoftFail = false) {
        let msg = "Sending data <" + syncData.getSyncState().split("||")[0] + "> for " + syncData.accountData.getAccountProperty("accountname");
        if (syncData.currentFolderData) msg += " (" + syncData.currentFolderData.getFolderProperty("name") + ")";
        syncData.request = eas.network.getRawXML(wbxml, msg);
        syncData.response = "";

        let connection = eas.network.getAuthData(syncData.accountData);
        let userAgent = syncData.accountData.getAccountProperty("useragent"); //plus calendar.useragent.extra = Lightning/5.4.5.2
        let deviceType = syncData.accountData.getAccountProperty("devicetype");
        let deviceId = syncData.accountData.getAccountProperty("deviceId");

        tbSync.dump("Sending (EAS v"+syncData.accountData.getAccountProperty("asversion") +")", "POST " + connection.host + '?Cmd=' + command + '&User=' + encodeURIComponent(connection.user) + '&DeviceType=' +deviceType + '&DeviceId=' + deviceId, true);
        
        return new Promise(function(resolve,reject) {
            // Create request handler - API changed with TB60 to new XMKHttpRequest()
            syncData.req = new XMLHttpRequest();
            syncData.req.mozBackgroundRequest = true;
            syncData.req.open("POST", connection.host + '?Cmd=' + command + '&User=' + encodeURIComponent(connection.user) + '&DeviceType=' +encodeURIComponent(deviceType) + '&DeviceId=' + deviceId, true);
            syncData.req.overrideMimeType("text/plain");
            syncData.req.setRequestHeader("User-Agent", userAgent);
            syncData.req.setRequestHeader("Content-Type", "application/vnd.ms-sync.wbxml");
            syncData.req.setRequestHeader("Authorization", 'Basic ' + tbSync.tools.b64encode(connection.user + ':' + connection.password));
            if (syncData.accountData.getAccountProperty("asversion") == "2.5") {
                syncData.req.setRequestHeader("MS-ASProtocolVersion", "2.5");
            } else {
                syncData.req.setRequestHeader("MS-ASProtocolVersion", "14.0");
            }
            syncData.req.setRequestHeader("Content-Length", wbxml.length);
            if (syncData.accountData.getAccountProperty("provision") == "1") {
                syncData.req.setRequestHeader("X-MS-PolicyKey", syncData.accountData.getAccountProperty("policykey"));
                tbSync.dump("PolicyKey used", syncData.accountData.getAccountProperty("policykey"));
            }

            syncData.req.timeout = eas.base.getConnectionTimeout(syncData);

            syncData.req.ontimeout = function () {
                if (allowSoftFail) {
                    resolve("");
                } else {
                    reject(eas.sync.finishSync("timeout", eas.flags.abortWithError));
                }
            };

            syncData.req.onerror = function () {
                if (allowSoftFail) {
                    resolve("");
                } else {
                    let error = tbSync.createTCPErrorFromFailedXHR(syncData.req);
                    if (!error) {
                        reject(eas.sync.finishSync("networkerror", eas.flags.abortWithServerError));
                    } else {
                        reject(eas.sync.finishSync(error, eas.flags.abortWithServerError));
                    }
                }
            };

            syncData.req.onload = function() {
                let response = syncData.req.responseText;
                switch(syncData.req.status) {

                    case 200: //OK
                        let msg = "Receiving data <" + syncData.getSyncState().split("||")[0] + "> for " + syncData.accountData.getAccountProperty("accountname");
                        if (syncData.currentFolderData) msg += " (" + syncData.currentFolderData.getFolderProperty("name") + ")";
                        syncData.response = eas.network.getRawXML(response, msg);

                        //What to do on error? IS this an error? Yes!
                        if (!allowSoftFail && response.length !== 0 && response.substr(0, 4) !== String.fromCharCode(0x03, 0x01, 0x6A, 0x00)) {
                            tbSync.dump("Recieved Data", "Expecting WBXML but got junk (request status = " + syncData.req.status + ", ready state = " + syncData.req.readyState + "\n>>>>>>>>>>\n" + response + "\n<<<<<<<<<<\n");
                            reject(eas.sync.finishSync("invalid"));
                        } else {
                            resolve(response);
                        }
                        break;

                    case 401: // AuthError
                    case 403: // Forbiddden (some servers send forbidden on AuthError, like Freenet)
                        reject(eas.sync.finishSync("401", eas.flags.abortWithError));
                        break;

                    case 449: // Request for new provision (enable it if needed)
                        //enable provision
                        syncData.accountData.setAccountProperty("provision","1");
                        syncData.accountData.resetAccountProperty("policykey");
                        reject(eas.sync.finishSync(syncData.req.status, eas.flags.resyncAccount));
                        break;

                    case 451: // Redirect - update host and login manager 
                        let header = syncData.req.getResponseHeader("X-MS-Location");
                        let newHost = header.slice(header.indexOf("://") + 3, header.indexOf("/M"));
                        let connection = eas.network.getAuthData(syncData.accountData);

                        tbSync.dump("redirect (451)", "header: " + header + ", oldHost: " + connection.host + ", newHost: " + newHost);

                        connection.host = newHost;
                        reject(eas.sync.finishSync(syncData.req.status, eas.flags.resyncAccount));
                        break;
                        
                    default:
                        if (allowSoftFail) {
                            resolve("");
                        } else {
                            reject(eas.sync.finishSync("httperror::" + syncData.req.status, eas.flags.abortWithError));
                        }
                }
            };

            syncData.req.send(wbxml);
            
        });
    },




    // RESPONSE EVALUATION
    
    getRawXML : function (wbxml, what) {
        let rawxml = eas.wbxmltools.convert2xml(wbxml);
        let xml = null;
        if (rawxml)  {
            xml = rawxml.split('><').join('>\n<');
        }
        
        //include xml in log, if userdatalevel 2 or greater
        if ((tbSync.prefs.getBoolPref("log.toconsole") || tbSync.prefs.getBoolPref("log.tofile")) && tbSync.prefs.getIntPref("log.userdatalevel")>1) {

            //log raw wbxml if userdatalevel is 3 or greater
            if (tbSync.prefs.getIntPref("log.userdatalevel")>2) {
                let charcodes = [];
                for (let i=0; i< wbxml.length; i++) charcodes.push(wbxml.charCodeAt(i).toString(16));
                let bytestring = charcodes.join(" ");
                tbSync.dump("WBXML: " + what, "\n" + bytestring);
            }

            if (xml) {
                //raw xml is save xml with all special chars in user data encoded by encodeURIComponent - KEEP that in order to be able to analyze logged XML 
                //let xml = decodeURIComponent(rawxml.split('><').join('>\n<'));
                //if userdatalevel is 3 or greater print everything, otherwise exclude application data
                if (tbSync.prefs.getIntPref("log.userdatalevel")<3) {
                    let rx = new RegExp("<ApplicationData[\\d\\D]*?\/ApplicationData>", "g");
                    tbSync.dump("XML: " + what, "\n" + xml.replace(rx, ""));
                } else {
                    tbSync.dump("XML: " + what, "\n" + xml);
                }
            } else {
                tbSync.dump("XML: " + what, "\nFailed to convert WBXML to XML!\n");
            }
        }
    
    return xml;
    },
    
    //returns false on parse error and null on empty response (if allowed)
    getDataFromResponse: function (wbxml, allowEmptyResponse = !eas.flags.allowEmptyResponse) {        
        //check for empty wbxml
        if (wbxml.length === 0) {
            if (allowEmptyResponse) return null;
            else throw eas.sync.finishSync("empty-response");
        }

        //convert to save xml (all special chars in user data encoded by encodeURIComponent) and check for parse errors
        let xml = eas.wbxmltools.convert2xml(wbxml);
        if (xml === false) {
            throw eas.sync.finishSync("wbxml-parse-error");
        }
        
        //retrieve data and check for empty data (all returned data fields are already decoded by decodeURIComponent)
        let wbxmlData = eas.xmltools.getDataFromXMLString(xml);
        if (wbxmlData === null) {
            if (allowEmptyResponse) return null;
            else throw eas.sync.finishSync("response-contains-no-data");
        }
        
        //debug
        eas.xmltools.printXmlData(wbxmlData, false); //do not include ApplicationData in log
        return wbxmlData;
    },  
  
  
    
    // WBXML DATA EXTRACTION FROM RESPONSE
    
    getPolicykey: async function (syncData)  {
        //build WBXML to request provision
       syncData.setSyncState("prepare.request.provision");
        let wbxml = eas.wbxmltools.createWBXML();
        wbxml.switchpage("Provision");
        wbxml.otag("Provision");
            wbxml.otag("Policies");
                wbxml.otag("Policy");
                    wbxml.atag("PolicyType", (syncData.accountData.getAccountProperty("asversion") == "2.5") ? "MS-WAP-Provisioning-XML" : "MS-EAS-Provisioning-WBXML" );
                wbxml.ctag();
            wbxml.ctag();
        wbxml.ctag();

        for (let loop=0; loop < 2; loop++) {
           syncData.setSyncState("send.request.provision");
            let response = await eas.network.sendRequest(wbxml.getBytes(), "Provision", syncData);

            syncData.setSyncState("eval.response.provision");
            let wbxmlData = eas.network.getDataFromResponse(response);
            let policyStatus = eas.xmltools.getWbxmlDataField(wbxmlData, "Provision.Policies.Policy.Status");
            let provisionStatus = eas.xmltools.getWbxmlDataField(wbxmlData, "Provision.Status");
            if (provisionStatus === false) {
                throw eas.sync.finishSync("wbxmlmissingfield::Provision.Status", eas.flags.abortWithError);
            } else if (provisionStatus != "1") {
                //dump policy status as well
                if (policyStatus) tbSync.dump("PolicyKey","Received policy status: " + policyStatus);
                throw eas.sync.finishSync("provision::" + provisionStatus, eas.flags.abortWithError);
            }

            //reaching this point: provision status was ok
            let policykey = eas.xmltools.getWbxmlDataField(wbxmlData,"Provision.Policies.Policy.PolicyKey");
            switch (policyStatus) {
                case false:
                    throw eas.sync.finishSync("wbxmlmissingfield::Provision.Policies.Policy.Status", eas.flags.abortWithError);

                case "2":
                    //server does not have a policy for this device: disable provisioning
                    syncData.accountData.setAccountProperty("provision","0")
                    syncData.accountData.resetAccountProperty("policykey");
                    throw eas.sync.finishSync("NoPolicyForThisDevice", eas.flags.resyncAccount);

                case "1":
                    if (policykey === false) {
                        throw eas.sync.finishSync("wbxmlmissingfield::Provision.Policies.Policy.PolicyKey", eas.flags.abortWithError);
                    } 
                    tbSync.dump("PolicyKey","Received policykey (" + loop + "): " + policykey);
                    syncData.accountData.setAccountProperty("policykey", policykey);
                    break;

                default:
                    throw eas.sync.finishSync("policy." + policyStatus, eas.flags.abortWithError);
            }

            //build WBXML to acknowledge provision
           syncData.setSyncState("prepare.request.provision");
            wbxml = eas.wbxmltools.createWBXML();
            wbxml.switchpage("Provision");
            wbxml.otag("Provision");
                wbxml.otag("Policies");
                    wbxml.otag("Policy");
                        wbxml.atag("PolicyType",(syncData.accountData.getAccountProperty("asversion") == "2.5") ? "MS-WAP-Provisioning-XML" : "MS-EAS-Provisioning-WBXML" );
                        wbxml.atag("PolicyKey", policykey);
                        wbxml.atag("Status", "1");
                    wbxml.ctag();
                wbxml.ctag();
            wbxml.ctag();
            
            //this wbxml will be used by Send at the top of this loop
        }
    },



    
    getServerOptions: function (syncData) {        
        syncData.setSyncState("prepare.request.options");
        let authData = eas.network.getAuthData(syncData.accountData);

        let userAgent = syncData.accountData.getAccountProperty("useragent"); //plus calendar.useragent.extra = Lightning/5.4.5.2
        tbSync.dump("Sending", "OPTIONS " + authData.host);
        
        return new Promise(function(resolve,reject) {
            // Create request handler - API changed with TB60 to new XMKHttpRequest()
            syncData.req = new XMLHttpRequest();
            syncData.req.mozBackgroundRequest = true;
            syncData.req.open("OPTIONS", authData.host, true);
            syncData.req.overrideMimeType("text/plain");
            syncData.req.setRequestHeader("User-Agent", userAgent);            
            syncData.req.setRequestHeader("Authorization", 'Basic ' + tbSync.tools.b64encode(authData.user + ':' + authData.password));
            syncData.req.timeout = eas.base.getConnectionTimeout(syncData);

            syncData.req.ontimeout = function () {
                resolve();
            };

            syncData.req.onerror = function () {
                resolve();
            };

            syncData.req.onload = function() {
                syncData.setSyncState("eval.request.options");
                let responseData = {};

                switch(syncData.req.status) {
                    case 401: // AuthError
                            reject(eas.sync.finishSync("401", eas.flags.abortWithError));
                        break;

                    case 200:
                            responseData["MS-ASProtocolVersions"] =  syncData.req.getResponseHeader("MS-ASProtocolVersions");
                            responseData["MS-ASProtocolCommands"] =  syncData.req.getResponseHeader("MS-ASProtocolCommands");                        

                            tbSync.dump("EAS OPTIONS with response (status: 200)", "\n" +
                            "responseText: " + syncData.req.responseText + "\n" +
                            "responseHeader(MS-ASProtocolVersions): " + responseData["MS-ASProtocolVersions"]+"\n" +
                            "responseHeader(MS-ASProtocolCommands): " + responseData["MS-ASProtocolCommands"]);

                            if (responseData && responseData["MS-ASProtocolCommands"] && responseData["MS-ASProtocolVersions"]) {
                                syncData.accountData.setAccountProperty("allowedEasCommands", responseData["MS-ASProtocolCommands"]);
                                syncData.accountData.setAccountProperty("allowedEasVersions", responseData["MS-ASProtocolVersions"]);
                                syncData.accountData.setAccountProperty("lastEasOptionsUpdate", Date.now());
                            }
                            resolve();
                        break;

                    default:
                            resolve();
                        break;

                }
            };
            
            syncData.setSyncState("send.request.options");
            syncData.req.send();
            
        });
    },




    // AUTODISCOVER        
    updateServerConnectionViaAutodiscover: async function (syncData) {
        syncData.setSyncState("prepare.request.autodiscover");
        let authData = eas.network.getAuthData(syncData.accountData);

        syncData.setSyncState("send.request.autodiscover");
        let result = await eas.network.getServerConnectionViaAutodiscover(authData.user, authData.password, 30*1000);

        syncData.setSyncState("eval.response.autodiscover");
        if (result.errorcode == 200) {
            //update account
            syncData.accountData.setAccountProperty("host", eas.network.stripAutodiscoverUrl(result.server)); 
            syncData.accountData.setAccountProperty("user", result.user);
            syncData.accountData.setAccountProperty("https", (result.server.substring(0,5) == "https") ? "1" : "0");
        }

        return result.errorcode;
    },
    
    stripAutodiscoverUrl: function(url) {
        let u = url;
        while (u.endsWith("/")) { u = u.slice(0,-1); }
        if (u.endsWith("/Microsoft-Server-ActiveSync")) u=u.slice(0, -28);
        else tbSync.dump("Received non-standard EAS url via autodiscover:", url);

        return u.split("//")[1]; //cut off protocol
    },

    getServerConnectionViaAutodiscover : async function (user, password, maxtimeout) {
        let urls = [];
        let parts = user.split("@");
        
        urls.push({"url":"http://autodiscover."+parts[1]+"/autodiscover/autodiscover.xml", "user":user});
        urls.push({"url":"http://"+parts[1]+"/autodiscover/autodiscover.xml", "user":user});
        urls.push({"url":"http://autodiscover."+parts[1]+"/Autodiscover/Autodiscover.xml", "user":user});
        urls.push({"url":"http://"+parts[1]+"/Autodiscover/Autodiscover.xml", "user":user});

        urls.push({"url":"https://autodiscover."+parts[1]+"/autodiscover/autodiscover.xml", "user":user});
        urls.push({"url":"https://"+parts[1]+"/autodiscover/autodiscover.xml", "user":user});
        urls.push({"url":"https://autodiscover."+parts[1]+"/Autodiscover/Autodiscover.xml", "user":user});
        urls.push({"url":"https://"+parts[1]+"/Autodiscover/Autodiscover.xml", "user":user});
        
        let requests = [];
        for (let i=0; i< urls.length; i++) {
            await tbSync.tools.sleep(200, false);
            requests.push( eas.network.getServerConnectionViaAutodiscoverRedirectWrapper(urls[i].url, urls[i].user, password, maxtimeout) );
        }
 
        let responses = []; //array of objects {url, error, server}
        try {
            responses = await Promise.all(requests); 
        } catch (e) {
            responses.push(e); //this is actually a success, see return value of getServerConnectionViaAutodiscoverRedirectWrapper()
        }
        
        let result;
        let log = [];        
        for (let r=0; r < responses.length; r++) {
            log.push("*  "+responses[r].url+" @ " + responses[r].user +" : " + (responses[r].server ? responses[r].server : responses[r].error));

            if (responses[r].server) {
                result = {"server": responses[r].server, "user": responses[r].user, "error": "", "errorcode": 200};
                break;
            }
            
            if (responses[r].error == 403 || responses[r].error == 401) {
                //we could still find a valid server, so just store this state
                result = {"server": "", "user": responses[r].user, "errorcode": responses[r].error, "error": tbSync.getString("status." + responses[r].error, "eas")};
            }
        } 
        
        //this is only reached on fail, if no result defined yet, use general error
        if (!result) { 
            result = {"server": "", "user": user, "error": tbSync.getString("autodiscover.Failed","eas").replace("##user##", user), "errorcode": 503};
        }

        tbSync.errorlog.add("error", new tbSync.ErrorInfo("eas"), result.error, log.join("\n"));
        return result;        
    },
       
    getServerConnectionViaAutodiscoverRedirectWrapper : async function (url, user, password, maxtimeout) {        
        //using HEAD to find URL redirects until response URL no longer changes 
        // * XHR should follow redirects transparently, but that does not always work, POST data could get lost, so we
        // * need to find the actual POST candidates (example: outlook.de accounts)
        let result = {};
        let method = "HEAD";
        let connection = { url, user };
        
        do {            
            await tbSync.tools.sleep(200, false);
            result = await eas.network.getServerConnectionViaAutodiscoverRequest(method, connection, password, maxtimeout);
            method = "";
            
            if (result.error == "redirect found") {
                tbSync.dump("EAS autodiscover URL redirect",  "\n" + connection.url + " @ " + connection.user + " => \n" + result.url + " @ " + result.user);
                connection.url = result.url;
                connection.user = result.user;
                method = "HEAD";
            } else if (result.error == "POST candidate found") {
                method = "POST";
            }

        } while (method);
        
        //invert reject and resolve, so we exit the promise group on success right away
        if (result.server) throw result;
        else return result;
    },    
    
    getServerConnectionViaAutodiscoverRequest: function (method, connection, password, maxtimeout) {
        tbSync.dump("Querry EAS autodiscover URL", connection.url + " @ " + connection.user);
        
        return new Promise(function(resolve,reject) {
            
            let xml = '<?xml version="1.0" encoding="utf-8"?>\r\n';
            xml += '<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/mobilesync/requestschema/2006">\r\n';
            xml += '<Request>\r\n';
            xml += '<EMailAddress>' + connection.user + '</EMailAddress>\r\n';
            xml += '<AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/mobilesync/responseschema/2006</AcceptableResponseSchema>\r\n';
            xml += '</Request>\r\n';
            xml += '</Autodiscover>\r\n';
            
            let userAgent = eas.prefs.getCharPref("clientID.useragent"); //plus calendar.useragent.extra = Lightning/5.4.5.2

            // Create request handler - API changed with TB60 to new XMKHttpRequest()
            let req = new XMLHttpRequest();
            req.mozBackgroundRequest = true;
            req.open(method, connection.url, true);
            req.timeout = maxtimeout;
            req.setRequestHeader("User-Agent", userAgent);
            
            let secure = (connection.url.substring(0,8).toLowerCase() == "https://");
            
            if (method == "POST") {
                req.setRequestHeader("Content-Length", xml.length);
                req.setRequestHeader("Content-Type", "text/xml");
                if (secure) req.setRequestHeader("Authorization", "Basic " + tbSync.tools.b64encode(connection.user + ":" + password));                
            }

            req.ontimeout = function () {
                tbSync.dump("EAS autodiscover with timeout", "\n" + connection.url + " => \n" + req.responseURL);
                resolve({"url":req.responseURL, "error":"timeout", "server":"", "user":connection.user});
            };
           
            req.onerror = function () {
                let error = tbSync.network.createTCPErrorFromFailedXHR(req);
                if (!error) error = req.responseText;
                tbSync.dump("EAS autodiscover with error ("+error+")",  "\n" + connection.url + " => \n" + req.responseURL);
                resolve({"url":req.responseURL, "error":error, "server":"", "user":connection.user});
            };

            req.onload = function() { 
                //initiate rerun on redirects
                if (req.responseURL != connection.url) {
                    resolve({"url":req.responseURL, "error":"redirect found", "server":"", "user":connection.user});
                    return;
                }

                //initiate rerun on HEAD request without redirect (rerun and do a POST on this)
                if (method == "HEAD") {
                    resolve({"url":req.responseURL, "error":"POST candidate found", "server":"", "user":connection.user});
                    return;
                }

                //ignore POST without autherization (we just do them to get redirect information)
                if (!secure) {
                    resolve({"url":req.responseURL, "error":"unsecure POST", "server":"", "user":connection.user});
                    return;
                }
                
                //evaluate secure POST requests which have not been redirected
                tbSync.dump("EAS autodiscover POST with status (" + req.status + ")",   "\n" + connection.url + " => \n" + req.responseURL  + "\n[" + req.responseText + "]");
                
                if (req.status === 200) {
                    let data = eas.xmltools.getDataFromXMLString(req.responseText);
            
                    if (!(data === null) && data.Autodiscover && data.Autodiscover.Response && data.Autodiscover.Response.Action) {
                        // "Redirect" or "Settings" are possible
                        if (data.Autodiscover.Response.Action.Redirect) {
                            // redirect, start again with new user
                            let newuser = action.Redirect;
                            resolve({"url":req.responseURL, "error":"redirect found", "server":"", "user":newuser});

                        } else if (data.Autodiscover.Response.Action.Settings) {
                            // get server settings
                            let server = eas.xmltools.nodeAsArray(data.Autodiscover.Response.Action.Settings.Server);

                            for (let count = 0; count < server.length; count++) {
                                if (server[count].Type == "MobileSync" && server[count].Url) {
                                    resolve({"url":req.responseURL, "error":"", "server":server[count].Url, "user":connection.user});
                                    return;
                                }
                            }
                        }
                    } else {
                        resolve({"url":req.responseURL, "error":"invalid", "server":"", "user":connection.user});
                    }
                } else {
                    resolve({"url":req.responseURL, "error":req.status, "server":"", "user":connection.user});                     
                }
            };
            
            if (method == "HEAD") req.send();
            else  req.send(xml);
            
        });
    },    

}
