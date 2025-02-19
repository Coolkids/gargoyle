/*
 * This program is copyright © 2008-2013 Eric Bishop and is distributed under the terms of the GNU GPL
 * version 2.0 with a special clarification/exception that permits adapting the program to
 * configure proprietary "back end" software provided that all modifications to the web interface
 * itself remain covered by the GPL.
 * See http://gargoyle-router.com/faq.html#qfoss for more information
 */
var DyDNS=new Object();

var serviceProviders;
var uci;
var newSections;
var updatedSections;
var resettingAfterFailedUpdate = false;

function saveChanges()
{
	setControlsEnabled(false, true);

	//completely re-build config data
	deleteCommands = [];
	sections = uciOriginal.getAllSections("ddns_gargoyle");
	for(sectionIndex=0; sectionIndex < sections.length; sectionIndex++)
	{
		deleteCommands.push("uci del ddns_gargoyle." + sections[sectionIndex]);
	}
	deleteCommands.push("uci commit");




	createCommands = uci.getScriptCommands(new UCIContainer());
	testCommands = ["/etc/init.d/ddns_gargoyle stop", "/etc/init.d/ddns_gargoyle test_config"];



	commands =  deleteCommands.join("\n") + "\n" + createCommands + "\n" + testCommands.join("\n");
	//document.getElementById("output").value = commands;
	var param = getParameterDefinition("commands", commands) + "&" + getParameterDefinition("hash", document.cookie.replace(/^.*hash=/,"").replace(/[\t ;]+.*$/, ""));



	var stateChangeFunction = function(req)
	{
		if(req.readyState == 4)
		{
			saveChangesPart2(req.responseText);
		}
	}
	runAjax("POST", "utility/run_commands.sh", param, stateChangeFunction);

}


function saveChangesPart2(response)
{
	resettingAfterFailedUpdate=false;

	responseLines=response.split(/[\r\n]+/);
	names=responseLines[0].split(/[\t ]+/);
	success=responseLines[1].split(/[\t ]+/);


	newFailedDomains = [];
	deleteCommands = [];

	//if config didn't change success.length == 0, and we won't run this loop
	for(nameIndex=0; nameIndex < names.length && names.length == success.length; nameIndex++)
	{
		if(success[nameIndex] == "0")
		{
			found=false;
			failedName = names[nameIndex];
			for(newIndex=0; newIndex < newSections.length && !found; newIndex++)
			{
				if(failedName == newSections[newIndex])
				{
					resettingAfterFailedUpdate=true;
					// set parameters in form to that of failed section, so they can
					// be edited/corrected
					setDocumentFromUci(uci, "ddns_gargoyle", failedName);

					found = true;
					failedDomain = uci.get("ddns_gargoyle", failedName, "domain");
					failedDomain = failedDomain == "" ? uci.get("ddns_gargoyle", failedName, "service_provider") : failedDomain;
					newFailedDomains.push(failedDomain);
					deleteCommands.push("uci del ddns_gargoyle." + failedName);
					uci.removeSection("ddns_gargoyle", failedName);
				}
			}
		}
	}
	deleteCommands.push("uci commit");

	if(newFailedDomains.length > 0)
	{
		alert(DyDNS.UpErr1+":\n" + newFailedDomains.join("\n") + "\n\n"+DyDNS.UpErr2);
	}

	getUpdateTimeCommands = [];
	sections = uci.getAllSections("ddns_gargoyle");
	for(sectionIndex=0; sectionIndex < sections.length; sectionIndex++)
	{
		getUpdateTimeCommands.push("echo " + sections[sectionIndex] + " $(cat /var/last_ddns_updates/" + sections[sectionIndex] + ")" );
	}

	commands =  deleteCommands.join("\n") + "\n" + "/etc/init.d/ddns_gargoyle enable\n" + "/etc/init.d/ddns_gargoyle restart\n" + getUpdateTimeCommands.join("\n");
	var param = getParameterDefinition("commands", commands) + "&" + getParameterDefinition("hash", document.cookie.replace(/^.*hash=/,"").replace(/[\t ;]+.*$/, ""));
;

	var stateChangeFunction = function(req)
	{
		if(req.readyState == 4)
		{
			responseLines=req.responseText.split(/[\r\n]+/);
			for(responseIndex=0; responseIndex < responseLines.length-1; responseIndex++)
			{
				lineParts=responseLines[responseIndex].split(/[\t ]+/);
				updateTimes[ lineParts[0] ] = lineParts[1];
			}

			uciOriginal = uci.clone();
			resetData();
			setControlsEnabled(true);
		}
	}
	runAjax("POST", "utility/run_commands.sh", param, stateChangeFunction);
}


function resetData()
{
	//set description visibility
	initializeDescriptionVisibility(uciOriginal, "ddns_1");
	uciOriginal.removeSection("gargoyle", "help"); //necessary, or we over-write the help settings when we save

	//initialize global variables
	uci = uciOriginal.clone();
	newSections = [];
	updatedSections = [];
	serviceProviders=parseProviderData();


	// setup providers in add section
	// also, make sure freedns.afraid.org is at top of list [ DO NOT CHANGE THIS! ]
	var providerNames = [];
	var providerValues = [];
	var providerIndex;
	var foundAfraid = false;
	for(providerIndex=0; providerIndex < serviceProviders.length; providerIndex++)
	{
		var p = serviceProviders[providerIndex]["name"]
		if(p != "freedns.afraid.org" && p != "freedns.afraid.org_v6")
		{
			var nameMatch = serviceProviders[providerIndex]["name"].match(/(.*)_v6$/);
			var name = serviceProviders[providerIndex]["name"];
			name = nameMatch != null ? nameMatch[1] + " (IPv6)" : name; 
			providerNames.push( name );
			providerValues.push( serviceProviders[providerIndex]["name"] );
		}
		else
		{
			foundAfraid=true;
		}
	}

	providerNames.sort(function(a, b) {
		a = a.toLowerCase();
		b = b.toLowerCase();
		return a < b ? -1 : a > b ? 1 : 0
	});
	providerValues.sort(function(a, b) {
		a = a.toLowerCase();
		b = b.toLowerCase();
		return a < b ? -1 : a > b ? 1 : 0
	});
	if(foundAfraid)
	{
		providerNames.unshift("freedns.afraid.org (IPv6)")
		providerValues.unshift("freedns.afraid.org_v6")
		providerNames.unshift("freedns.afraid.org")
		providerValues.unshift("freedns.afraid.org")
	}
	setAllowableSelections("ddns_provider", providerValues, providerNames, document);
	setSelectedValue("ddns_provider", 'freedns.afraid.org', document);


	if(!resettingAfterFailedUpdate)
	{
		setDocumentFromUci( new UCIContainer(), "", "");
	}
	resettingAfterFailedUpdate = false;

	// setup table of existing domains configured for ddns

	var sections = uci.getAllSections("ddns_gargoyle");
	var columnNames=DyDNS.cNams;
	var ddnsTableData = new Array();
	var ddnsEnabledData = new Array();
	for (sectionIndex=0; sectionIndex < sections.length; sectionIndex++)
	{
		var section = sections[sectionIndex];
		var domain = uciOriginal.get("ddns_gargoyle", section, "domain");
		var testDomain = uciOriginal.get("ddns_gargoyle", section, "test_domain");
		var provider = uciOriginal.get("ddns_gargoyle", section, "service_provider");
		domain = domain == "" ? provider : domain;
		domain = testDomain == "" ? domain : testDomain;

		var providerMatch = provider.match(/(.*)_v6$/);
		provider = providerMatch != null ? providerMatch[1] + " (IPv6)" : provider;

		var lastDate = new Date();
		if(updateTimes[section] != null)
		{
			lastDate.setTime(1000*updateTimes[section]);
		}

		var systemDateFormat = uciOriginal.get("gargoyle",  "global", "dateformat");
		var twod = function(num) { var nstr = "" + num; nstr = nstr.length == 1 ? "0" + nstr : nstr; return nstr; }

		var m = twod(lastDate.getMonth()+1);
		var d = twod(lastDate.getDate());
		var h = " " + lastDate.getHours() + ":" +  twod(lastDate.getMinutes())  + ":" + twod(lastDate.getSeconds());
		var lastUpdate = (systemDateFormat == "" || systemDateFormat == "usa" || systemDateFormat == "iso") ? m + "/" + d + h : d + "/" + m + h;
		lastUpdate = systemDateFormat == "russia" ? d + "." + m + h : lastUpdate;
		lastUpdate = systemDateFormat == "argentina" ? d + "/" + m + h : lastUpdate;
		lastUpdate = systemDateFormat == "iso8601" ? m + "-" + d + h : lastUpdate;
		lastUpdate = systemDateFormat == "hungary" ? m + "." + d + h : lastUpdate;
		lastUpdate =  updateTimes[section] == null ? UI.never : lastUpdate;

		var enabledCheckbox = createEnabledCheckbox();
		enabledCheckbox.checked = uciOriginal.get("ddns_gargoyle", section, "enabled") == "1" ? true : false;
		enabledCheckbox.id = section;
		ddnsTableData.push( [domain, provider, lastUpdate, enabledCheckbox, createEditButton(), createForceUpdateButton()]);

		var row = ddnsTableData[ddnsTableData.length-1][5];
		setElementEnabled(row, enabledCheckbox.checked);
		ddnsEnabledData.push(enabledCheckbox.checked);
 	}
	var ddnsTable=createTable(columnNames, ddnsTableData, "ddns_table", true, false, removeServiceProviderCallback);
	var tableContainer = document.getElementById('ddns_table_container');
	if(tableContainer.firstChild != null)
	{
		tableContainer.removeChild(tableContainer.firstChild);
	}
	tableContainer.appendChild(ddnsTable);

	// Because IE6 was designed by programmers whose only qualification was participation in the Special Olympics,
	// checkboxes become unchecked when added to table.  We need to reset checked status here.
	for(deIndex = 0; deIndex < ddnsEnabledData.length; deIndex++)
	{
		ddnsTableData[deIndex][2].checked = ddnsEnabledData[deIndex];
	}

	setAllowableSelections("ip_from", ["internet", wanIface, lanIface], ["Internet", wanIface + " (WAN)", lanIface + " (LAN)"]);
}

function addDdnsService()
{
	var errorList = proofreadServiceProvider();
	if(errorList.length > 0)
	{
		errorString = errorList.join("\n") + "\n\n"+UI.ErrChanges;
		alert(errorString);
	}
	else
	{
		//update uci (NOT uciOriginal)
		var sections = uci.getAllSections("ddns_gargoyle");
		var sectionNum = 1+sections.length;
		while( uci.get("ddns_gargoyle", "ddns_" + sectionNum) != '')
		{
			sectionNum++;
		}
		var section = "ddns_" + sectionNum;
		var providerName = getSelectedValue("ddns_provider");

		setUciFromDocument(uci, "ddns_gargoyle", section, document);


		var domain = uci.get("ddns_gargoyle", section, "domain");
		var testDomain = uci.get("ddns_gargoyle", section, "test_domain");
		domain = domain == "" ? providerName : domain;
		domain = testDomain == "" ? domain : testDomain;

		var providerMatch = providerName.match(/(.*)_v6$/);
		providerName = providerMatch != null ? providerMatch[1] + " (IPv6)" : providerName;

		var enabledCheckbox = createEnabledCheckbox();
		enabledCheckbox.checked = true;
		enabledCheckbox.id = section;
		var newTableRow =  [domain, providerName, UI.never, enabledCheckbox, createEditButton(), createForceUpdateButton()];

		var ddnsTable = document.getElementById('ddns_table_container').firstChild;
		addTableRow(ddnsTable, newTableRow, true, false, removeServiceProviderCallback);

		setDocumentFromUci( new UCIContainer(), "", "");

		newSections.push(section);
		updatedSections.push(section);

		closeModalWindow("ddns_service_modal");
	}
}
function removeServiceProviderCallback(table, row)
{
	var section = row.childNodes[3].firstChild.id;
	uci.removeSection("ddns_gargoyle", section);
}

function proofreadServiceProvider()
{
	var ddnsIds = ['ddns_check', 'ddns_force'];
	var labelIds= ['ddns_check_label', 'ddns_force_label'];
	var functions = [validateNumeric, validateNumeric];
	var returnCodes = [0,0];

	var validateNotNull=function(text){ return validateLengthRange(text, 1, 999); };




	var providerName;
	if(document.getElementById("ddns_provider_text") != null)
	{
		providerName = document.getElementById("ddns_provider_text").firstChild.data;
	}
	else
	{
		providerName = getSelectedValue("ddns_provider", document);
	}
	var provider = null;
	for(providerIndex=0; providerIndex < serviceProviders.length && provider == null; providerIndex++)
	{
		provider = serviceProviders[providerIndex]["name"] == providerName ? serviceProviders[providerIndex] : null;
	}
	if(provider == null)
	{
		alert(DyDNS.InvErr); //should never get here, but let's have an error message just in case
		return;
	}
	var variables=provider["variables"];
	var optionalVariables = provider["optional_variables"];
	var allBooleanVariables = [];
	var variableIndex=0;
	for(variableIndex=0; variableIndex < provider["boolean_variables"].length; variableIndex++)
	{
		allBooleanVariables[ provider["boolean_variables"][variableIndex] ] = 1;
	}
	for(variableIndex=0; variableIndex < variables.length; variableIndex++)
	{
		if(allBooleanVariables[ variables[variableIndex] ] != 1)
		{
			ddnsIds.push( variables[variableIndex] );
			labelIds.push( variables[variableIndex] + "_label" );
			functions.push(validateNotNull);
			returnCodes.push(0);
		}
	}
	for(variableIndex=0; variableIndex < optionalVariables.length; variableIndex++)
	{
		if(allBooleanVariables[ optionalVariables[variableIndex] ] != 1)
		{
			if( document.getElementById( optionalVariables[variableIndex] + "_enabled" ).checked )
			{
				ddnsIds.push( optionalVariables[variableIndex] );
				labelIds.push( optionalVariables[variableIndex] + "_label" );
				functions.push(validateNotNull);
				returnCodes.push(0);
			}
		}
	}



	var errors = proofreadFields(ddnsIds, labelIds, functions, returnCodes, ddnsIds, document);


	//we don't have a proofread functions on provider elements
	//so we need to make sure class is set to default (not error) for all of them
	for(variableIndex=0; variableIndex < variables.length; variableIndex++)
	{
		if(allBooleanVariables[ variables[variableIndex] ] != 1)
		{
			document.getElementById( variables[variableIndex] ).className="";
		}
	}
	for(variableIndex=0; variableIndex < optionalVariables.length; variableIndex++)
	{
		if(allBooleanVariables[ optionalVariables[variableIndex] ] != 1)
		{
			if( document.getElementById( optionalVariables[variableIndex] + "_enabled" ).checked )
			{
				document.getElementById( optionalVariables[variableIndex] ).className="";
			}
		}
	}



	//verify domain name is not duplicate
	if(errors.length == 0)
	{
		var domain;
		if( document.getElementById("domain") != null)
		{
			domain = document.getElementById("domain").value;
		}
		else
		{
			domain = providerName;
		}
		if(document.getElementById("test_domain") != null)
		{
			var testDomain = document.getElementById("test_domain").value;
			domain = testDomain == "" ? domain : testDomain;
		}
		var ipv6 = providerName.match(/(.*)_v6$/) != null ? "1" : "0";
		var allServices = uci.getAllSectionsOfType("ddns_gargoyle", "service");
		var domainMatches = false;
		for(serviceIndex = 0; serviceIndex < allServices.length && domainMatches == false; serviceIndex++)
		{
			var testDomain = uci.get("ddns_gargoyle", allServices[serviceIndex], "domain");
			var testDomainVar = uci.get("ddns_gargoyle", allServices[serviceIndex], "test_domain");
			testDomain = testDomain == "" ? uci.get("ddns_gargoyle", allServices[serviceIndex], "service_provider") : testDomain;
			testDomain = testDomainVar == "" ? testDomain : testDomainVar;
			var testIpv6 = uci.get("ddns_gargoyle", allServices[serviceIndex], "ipv6");
			testIpv6 = testIpv6 == "" ? "0" : testIpv6;
			domainMatches = (testDomain == domain) && (ipv6 == testIpv6) ? true : false;
		}
		if(domainMatches)
		{
			errors.push(DyDNS.DupErr);
		}
	}

	return errors;
}


function setUciFromDocument(dstUci, pkg, section)
{
	var providerName;
	if(document.getElementById("ddns_provider_text") != null)
	{
		providerName = document.getElementById("ddns_provider_text").firstChild.data;
	}
	else
	{
		providerName = getSelectedValue("ddns_provider", document);
	}

	dstUci.removeSection("ddns_gargoyle", section);
	dstUci.set("ddns_gargoyle", section, "", "service");
	dstUci.set("ddns_gargoyle", section, "enabled", "1");
	dstUci.set("ddns_gargoyle", section, "service_provider", providerName);
	if(providerName.match(/.*_v6$/) != null)
	{
		dstUci.set("ddns_gargoyle", section, "ipv6", "1");
	}
	else
	{
		dstUci.remove("ddns_gargoyle", section, "ipv6");
	}
	var ip_from = getSelectedValue("ip_from", document);
	if(ip_from != "internet")
	{
		dstUci.set("ddns_gargoyle", section, "ip_source", "interface");
		dstUci.set("ddns_gargoyle", section, "ip_interface", ip_from);
	}
	else
	{
		dstUci.set("ddns_gargoyle", section, "ip_source", "internet");
		dstUci.remove("ddns_gargoyle", section, "ip_interface");
	}
	dstUci.set("ddns_gargoyle", section, "force_interval", document.getElementById("ddns_force").value  );
	dstUci.set("ddns_gargoyle", section, "force_unit", "days");
	dstUci.set("ddns_gargoyle", section, "check_interval", document.getElementById("ddns_check").value );
	dstUci.set("ddns_gargoyle", section, "check_unit", "minutes");

	var provider = null;
	for(providerIndex=0; providerIndex < serviceProviders.length && provider == null; providerIndex++)
	{
		provider = serviceProviders[providerIndex]["name"] == providerName ? serviceProviders[providerIndex] : null;
	}
	if(provider == null)
	{
		alert(DyDNS.InvErr); //should never get here, but let's have an error message just in case
		return;
	}
	var variables=provider["variables"];
	var optionalVariables = provider["optional_variables"];
	var allBooleanVariables = [];
	var variableIndex=0;
	for(variableIndex=0; variableIndex < provider["boolean_variables"].length; variableIndex++)
	{
		allBooleanVariables[ provider["boolean_variables"][variableIndex] ] = 1;
	}

	for(variableIndex=0; variableIndex < variables.length; variableIndex++)
	{
		var el = document.getElementById(variables[variableIndex]);
		var value = allBooleanVariables[ el.id ] != 1 ? el.value : (el.checked ? "1" : "0");
		if(value != "")
		{
			dstUci.set("ddns_gargoyle", section, el.id, value);
		}
	}
	for(variableIndex=0; variableIndex < optionalVariables.length; variableIndex++)
	{
		var el = document.getElementById(optionalVariables[variableIndex]);
		if( allBooleanVariables[ el.id ] != 1)
		{
			if(document.getElementById( el.id + "_enabled").checked)
			{
				dstUci.set("ddns_gargoyle", section, el.id, el.value);
			}
		}
		else
		{
			dstUci.set("ddns_gargoyle", section, el.id, el.checked ? "1" : "0");
		}
	}
}


function setDocumentFromUci(srcUci, pkg, section)
{
	var providerName = srcUci.get(pkg, section, "service_provider");
	if(document.getElementById("ddns_provider_text") != null)
	{
		document.getElementById("ddns_provider_text").appendChild(document.createTextNode(providerName));
	}
	else
	{
		setSelectedValue("ddns_provider", providerName, document);
	}
	var provider = setProvider();
	var variables = provider["variables"];
	var optionalVariables = provider["optional_variables"];
	var allBooleanVariables = [];
	var variableIndex=0;
	for(variableIndex=0; variableIndex < provider["boolean_variables"].length; variableIndex++)
	{
		allBooleanVariables[ provider["boolean_variables"][variableIndex] ] = 1;
	}
	for(variableIndex = 0; variableIndex < variables.length; variableIndex++)
	{
		var el = document.getElementById( variables[variableIndex] );
		if( allBooleanVariables[ el.id ] != 1)
		{
			el.value = srcUci.get(pkg, section, el.id);
		}
		else
		{
			el.checked = srcUci.get(pkg, section, el.id) == "1" ? true : false;
		}
	}
	for(variableIndex = 0; variableIndex < optionalVariables.length; variableIndex++)
	{
		var el = document.getElementById( optionalVariables[variableIndex] );
		if( allBooleanVariables[ el.id ] != 1)
		{
			var check = document.getElementById( optionalVariables[variableIndex] + "_enabled" );
			check.checked = srcUci.get(pkg, section, el.id) != "";
			if(check.checked)
			{
				el.value = srcUci.get(pkg, section, el.id);
			}
			setElementEnabled(el, check.checked, "");
		}
		else
		{
			el.checked = srcUci.get(pkg, section, el.id) == "1" ? true : false;
		}
	}

	var checkMinutes = (getMultipleFromUnit( srcUci.get("ddns_gargoyle", section, "check_unit") ) * srcUci.get("ddns_gargoyle", section, "check_interval"))/(60);
	checkMinutes = (checkMinutes > 0) ? checkMinutes : 15;
	document.getElementById( "ddns_check" ).value = checkMinutes;


	var forceDays = (getMultipleFromUnit( srcUci.get("ddns_gargoyle", section, "force_unit") ) * srcUci.get("ddns_gargoyle", section, "force_interval"))/(24*60*60);
	forceDays = (forceDays > 0) ? forceDays : 3;
	document.getElementById( "ddns_force" ).value = forceDays;

	var ip_from = srcUci.get("ddns_gargoyle", section, "ip_interface");
	setSelectedValue("ip_from", ip_from ? ip_from : "internet");
}

function setProvider()
{
	var selected;
	if(document.getElementById("ddns_provider_text") != null)
	{
		selected = document.getElementById("ddns_provider_text").firstChild.data;
	}
	else
	{
		selected = getSelectedValue("ddns_provider", document);
	}
	var provider = null;
	for(providerIndex=0; providerIndex < serviceProviders.length && provider == null; providerIndex++)
	{
		provider = serviceProviders[providerIndex]["name"] == selected ? serviceProviders[providerIndex] : null;
	}
	if(provider != null) //should NEVER be null, but test just in case
	{
		var ext_script = provider["external_script"];
		document.getElementById("ddns_no_script").style.display="none";
		if(ext_script != "")
		{
			if(extScripts.indexOf(ext_script) == -1)
			{
				document.getElementById("ddns_no_script").style.display="block";
			}
		}
		var variables = provider["variables"];
		var variableNames = provider["variable_names"];
		var newElements = new Array();

		var allBooleanVariables = [];
		var variableIndex=0;
		for(variableIndex=0; variableIndex < provider["boolean_variables"].length; variableIndex++)
		{
			allBooleanVariables[ provider["boolean_variables"][variableIndex] ] = 1;
		}

		for(variableIndex = 0; variableIndex < variables.length; variableIndex++)
		{
			var div= document.createElement("div");
			div.className="row form-group";
			var label = document.createElement("label");
			label.className="col-xs-5";
			label.id=variables[variableIndex] + "_label";
			label.appendChild( document.createTextNode( (ObjLen(DyDNS)==0 ? variableNames[variableIndex] : eval(variableNames[variableIndex])) + ":" ));
			div.appendChild(label);
			var span = document.createElement("span");
			span.className="col-xs-7"

			var input;
			if(allBooleanVariables[ variables[variableIndex] ] != 1)
			{
				input = createInput("text", document);
				input.className = "form-control";
			}
			else
			{
				input = createInput("checkbox", document);
			}
			input.id = variables[variableIndex];
			span.appendChild(input);
			div.appendChild(span);
			newElements.push(div);

			label.setAttribute("for", input.id);
		}

		var optionalVariables = provider["optional_variables"];
		var optionalVariableNames = provider["optional_variable_names"];
		for(variableIndex = 0; variableIndex < optionalVariables.length; variableIndex++)
		{
			var div= document.createElement("div");
			div.className="row form-group";
			var label = document.createElement("label");
			label.className="col-xs-5";
			label.id=optionalVariables[variableIndex] + "_label";
			label.appendChild( document.createTextNode( (ObjLen(DyDNS)==0 ? optionalVariableNames[variableIndex] : eval(optionalVariableNames[variableIndex])) + ":" ));
			div.appendChild(label);
			if(allBooleanVariables[ optionalVariables[variableIndex] ] != 1)
			{
				var span = document.createElement("span");
				span.className = "col-xs-7";

				var check = createInput("checkbox", document);
				var text  = createInput("text", document);
				text.className="form-control";
				check.id = optionalVariables[variableIndex] + "_enabled";
				text.id  = optionalVariables[variableIndex];
				check.onclick= function()
				{
					var textId = this.id.replace("_enabled", "");
			     		setElementEnabled( document.getElementById(textId), this.checked, "");
				}
				span.appendChild(check);
				span.appendChild(text);
				div.appendChild(span);

				label.setAttribute("for", check.id);
			}
			else
			{
				var input = createInput("checkbox", document);
				input.id = optionalVariables[variableIndex];
				div.appendChild(input);

				label.setAttribute("for", input.id);
			}
			newElements.push(div);
		}


		container = document.getElementById("ddns_variable_container");
		while(container.childNodes.length > 0)
		{
			container.removeChild( container.firstChild );
		}
		for(newElementIndex = 0; newElementIndex < newElements.length; newElementIndex++)
		{
			container.appendChild(newElements[newElementIndex]);
		}

		for(variableIndex = 0; variableIndex < optionalVariables.length; variableIndex++)
		{
			if(allBooleanVariables[ optionalVariables[variableIndex] ] != 1)
			{
				setElementEnabled( document.getElementById(optionalVariables[variableIndex]), document.getElementById(optionalVariables[variableIndex] + "_enabled").checked, "");
			}
		}
	}
	return provider;
}

function createEnabledCheckbox()
{
	enabledCheckbox = createInput('checkbox');
	enabledCheckbox.onclick = setRowEnabled;
	return enabledCheckbox;
}


function createEditButton()
{
	editButton = createInput("button");
	editButton.textContent = UI.Edit;
	editButton.className = "btn btn-default btn-edit";
	editButton.onclick = editDDNSModal;
	return editButton;
}

function createForceUpdateButton()
{
	updateButton = createInput("button");
	updateButton.textContent = DyDNS.ForceU;
	updateButton.className = "btn btn-default btn-update";
	updateButton.onclick = forceUpdateForRow;
	return updateButton;
}

function setRowEnabled()
{
	var enabled= this.checked;
	var enabledRow=this.parentNode.parentNode;
	var enabledDomain = enabledRow.firstChild.firstChild.data;

	var row = enabledRow.childNodes[5].firstChild;
	setElementEnabled(row, enabled);

	var section = enabledRow.childNodes[3].firstChild.id;
	enabled = enabled ? "1" : "0";
	uci.set("ddns_gargoyle", section, "enabled", enabled);
	updatedSections.push(section);
}

function parseProviderData()
{
	providers = new Array();
	for(providerLineIndex=0; providerLineIndex < providerData.length; providerLineIndex++)
	{
		line = providerData[providerLineIndex];
		if(line.match(/^[\t ]*service[\t ]+/))
		{
			var provider = new Array();
			var splitService = line.split(/ervice[\t ]+/);
			provider["name"] = splitService[1];

			provider["optional_variables"] = [];
			provider["optional_variable_names"] = [];
			provider["boolean_variables"] = [];
			provider["external_script"] = "";

			line = "";
			providerLineIndex++;
			while(providerLineIndex < providerData.length && line.match(/^[\t ]*service[\t ]+/) == null)
			{
				line = providerData[providerLineIndex];
				if(line.match(/^[\t ]*required_variables[\t ]+/))
				{
					variablePart = (line.match(/ariables[\t ]+(.*)$/))[1];
					provider["variables"]=variablePart.split(/[\t ]+/);
				}
				else if(line.match(/^[\t ]*optional_variables[\t ]+/))
				{
					variablePart = (line.match(/ariables[\t ]+(.*)$/))[1];
					provider["optional_variables"]=variablePart.split(/[\t ]+/);
				}
				else if(line.match(/^[\t ]*required_variable_names[\t ]+/))
				{
					variablePart = (line.match(/ariable_names[\t ]+(.*)$/))[1];
					provider["variable_names"] = variablePart.split(/,/);
				}
				else if(line.match(/^[\t ]*optional_variable_names[\t ]+/))
				{
					variablePart = (line.match(/ariable_names[\t ]+(.*)$/))[1];
					provider["optional_variable_names"] = variablePart.split(/,/);
				}
				else if(line.match(/^[\t ]*boolean_variables[\t ]+/))
				{
					variablePart = (line.match(/ariables[\t ]+(.*)$/))[1];
					provider["boolean_variables"] = variablePart.split(/[\t ]+/);
				}
				else if(line.match(/^[\t ]*external_script[\t ]+/))
				{
					variablePart = (line.match(/script[\t ]+(.*)$/))[1];
					provider["external_script"] = variablePart;
				}
				providerLineIndex++;
			}
			if(provider["name"] != null && provider["variables"] != null && provider["variable_names"] != null)
			{
				providers.push(provider);
			}
			if(line.match(/^[\t ]*service[\t ]+/))
			{
				providerLineIndex = providerLineIndex-2;
			}
		}
	}
	return providers;
}

function forceUpdateForRow()
{
	var updateRow=this.parentNode.parentNode;
	var sections = uci.getAllSections("ddns_gargoyle");
	var updateDomain = updateRow.firstChild.firstChild.data;

	var section = updateRow.childNodes[3].firstChild.id;
	var needsUpdate=false;
	for(updatedIndex=0; updatedIndex < updatedSections.length && !needsUpdate; updatedIndex++)
	{
		needsUpdate = section == updatedSections[updatedIndex];
	}
	if(needsUpdate) //should check newSections instead (implement later)
	{
		alert(DyDNS.ModErr);
	}
	else
	{
		setControlsEnabled(false, true);
		var commands = "/usr/bin/ddns_gargoyle -P /etc/ddns_providers.conf -C /etc/ddns_gargoyle.conf -m -f " + section;
		commands = commands + "\n" + "echo $(cat /var/last_ddns_updates/" + section + ") ";
		var param = getParameterDefinition("commands", commands) + "&" + getParameterDefinition("hash", document.cookie.replace(/^.*hash=/,"").replace(/[\t ;]+.*$/, ""));


		var stateChangeFunction = function(req)
		{
			if(req.readyState == 4)
			{
				var responseLines=req.responseText.split(/[\r\n]+/);
				setControlsEnabled(true);
				if(responseLines[0].match(/0/))
				{
					alert(DyDNS.UpFErr);
				}
				else
				{
					alert(DyDNS.UpOK);
					updateTimes[section] = responseLines[1];
					resetData();
				}
			}
		}
		runAjax("POST", "utility/run_commands.sh", param, stateChangeFunction);
	}
}


function editServiceTableRow(editRow, section, providerName, selectedDomain)
{
	var newDomain = document.getElementById("domain") != null ? document.getElementById("domain").value : providerName;
	var testDomain = document.getElementById("test_domain")!= null ? document.getElementById("test_domain").value : "";
	newDomain = testDomain == "" ? newDomain : testDomain;

	var errors = proofreadServiceProvider();
	if(errors.length == 1)
	{
		var dupRegEx=new RegExp(DyDNS.DupErr);
		if(errors[0].match(dupRegEx) && newDomain == selectedDomain)
		{
			errors = [];
		}
	}
	if(errors.length > 0)
	{
		alert(errors.join("\n") + "\n\n"+DyDNS.UpSrvErr);
	}
	else
	{
		editRow.firstChild.firstChild.data = newDomain;
		setUciFromDocument(uci, "ddns_gargoyle", section, document);
		updatedSections.push(section);
		closeModalWindow('ddns_service_modal');
	}
}

function getMultipleFromUnit(unit)
{
	multiple = 1;
	if(unit == "minutes")
	{
		multiple = 60;
	}
	else if(unit == "hours")
	{
		multiple = 60*60;
	}
	else if(unit == "days")
	{
		multiple = 24*60*60;
	}
	else if(unit == "weeks")
	{
		multiple = 7*24*60*60;
	}
	else
	{
		multiple = 1;
	}
	return multiple;
}

function addDDNSModal()
{
	modalButtons = [
		{"title" : UI.Add, "classes" : "btn btn-primary", "function" : addDdnsService},
		"defaultDismiss"
	];

	modalElements = [];
	setProvider();
	modalPrepare('ddns_service_modal', DyDNS.AddDy, modalElements, modalButtons);
	openModalWindow('ddns_service_modal');
}

function editDDNSModal()
{
	editRow=this.parentNode.parentNode;
	//load provider data for this row
	var section = editRow.childNodes[3].firstChild.id;
	var providerName = uci.get("ddns_gargoyle", section, "service_provider");
	var selectedDomain = uci.get("ddns_gargoyle", section, "domain");
	var testDomain = uci.get("ddns_gargoyle", section, "test_domain");
	selectedDomain = selectedDomain == "" ? providerName : selectedDomain;
	selectedDomain = testDomain == "" ? selectedDomain : testDomain;

	modalButtons = [
		{"title" : UI.CApplyChanges, "classes" : "btn btn-primary", "function" : function(){editServiceTableRow(editRow, section, providerName, selectedDomain);}},
		"defaultDiscard"
	];

	modalElements = [
		{'id' : 'ddns_provider', 'disable' : true}
	];

	setDocumentFromUci(uci, "ddns_gargoyle", section);

	modalPrepare('ddns_service_modal', DyDNS.EDSect, modalElements, modalButtons);
	openModalWindow('ddns_service_modal');
}
