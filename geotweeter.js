/****************************************/
/********** Fabians Geotweeter **********/
/****************************************/



/** Keeps track of how much of the server stream has already been processed. */
var responseOffset = 0;

/** Contains "new" parts of the stream for processing. */
var buffer = "";

/** isProcessing is true while parseData is running. */
var isProcessing = false;

/** Keeps track of a user and his tweet's id if we're replying to a tweet. */
var reply_to_user = null;
var reply_to_id = null;

/** ID of last "marked as read" tweet. Any tweet with an ID bigger than this is considered new. */
var maxreadid = 0;

/** IDs of newest and oldest knwon tweets. */
var maxknownid = "0";
var minknownid = "0";

/** ID of the newest tweet belonging to "this" user. */
var mylasttweetid = 0;

/** delay to use the next time the stream gets disconnected. */
var delay;

/** Time the connection to the streaming API was established / got the last data. */
var connectionStartedAt = new Date();
var lastDataReceivedAt = null;

/** true, if the streaming connection was terminated because of a timeout. */
var disconnectBecauseOfTimeout = false;

/** Keeps track of all tweets being replied to. */
var repliesData = new Array();

/** Gets filled by verify_credentials with the current user's name. */
var this_users_name = null;

/** Gets filled with the IDs of all followers. */
var followers_ids = new Array();

/** Collects all possible autocompletion values. */
var autocompletes = new Array();

/** Expected version of settings.js. Gets compared to settings.version by checkSettings(). */
var expected_settings_version = 8;

/** Time of the last press of Enter. Used for double-Enter-recognition. */
var timeOfLastEnter = 0;

/** Text from the textbox before pressing double-enter. Used to remove unwanted newlines. */
var textBeforeEnter = "";

/** Lengths of automatically shorted t.co-links */
var short_url_length = null;
var short_url_length_https = null;
var characters_reserved_per_media = null;
var max_media_per_upload = null;
var photo_size_limit = null;

/** If file-field is visible */
var show_file_field = false;

/** Saves the creation-times of the last received tweets. */
var last_event_times = new Array();

regexp_url = /((https?:\/\/)(([^ :]+(:[^ ]+)?@)?[a-zäüöß0-9]([a-zäöüß0-9i\-]{0,61}[a-zäöüß0-9])?(\.[a-zäöüß0-9]([a-zäöüß0-9\-]{0,61}[a-zäöüß0-9])?){0,32}\.[a-z]{2,5}(\/[^ \"@\n]*[^" \.,;\)@\n])?))/ig;
regexp_user = /(^|\s)@([a-zA-Z0-9_]+)/g;
regexp_hash = /(^|\s)#([\wäöüÄÖÜß]+)/g;
regexp_cache = /(^|\s)(GC[A-Z0-9]+)/g;


$(document).ready(start);

/** Gets run as soon as the page finishes loading. Initializes Variables, sets timers, starts requests. */
function start() {
    if (!checkSettings()) {
        alert("settings.js veraltet. Bitte mit settings.js.example abgleichen und DANACH die Version auf " + expected_settings_version + " setzen. Breche ab.");
        return;
    }

    delay = settings.timings.mindelay;

    // Fill Places
    if (settings.places.length==0) {
        // If there are no places defined in settings.js, we don't even show the dropdown field
        $("#place").remove();
    } else {
        // otherwise, the first (default) entry is an empty entry
        document.tweet_form.place.options[document.tweet_form.place.length] = new Option("-- leer --", 0);
        for(var i=0; i<settings.places.length; i++) {
            document.tweet_form.place.options[document.tweet_form.place.length] = new Option(settings.places[i].name, i+1);
        }
        
        if ($.cookie('last_place')) $("#place option[value='" + $.cookie('last_place') + "']").attr('selected', true);
    }

    $('#place').change(function(){
        $.cookie('last_place', $('#place option:selected').val(), {expires: 365});
    });

    $('#file').change(check_file);

    for(var i=0; i<settings.chars.length; i++) {
        $('#chars').append('<a href="#" onClick="$(\'#text\').val($(\'#text\').val() + \'' + settings.chars[i] + '\');">' + settings.chars[i] + '</a>');
    }

    // check the credentials and exit if not okay.
    validateCredentials();
    get_twitter_configuration();
    if (!this_users_name) return;


    getFollowers();

    maxreadid = getMaxReadID();
    startRequest();

    updateCounter();

    $(document).bind('keydown', 'Alt+s', sendTweet);
    $('#text').bind('keydown', 'return', checkEnter);

    $('#text').autocomplete({
        minLength: 1,
        source: function(request, response) {
            var word = extractLast(request.term);
            if (word[0]!="@" && word[0]!="#") response(new Array());
            else response($.ui.autocomplete.filter(autocompletes, extractLast(request.term)));
        },
        focus: function() { return false; },
        autoFocus: true,
        delay: 0,
        appendTo: "#autocomplete_area",
        select: function(event, ui) {
            var term = this.value.split(/\s+/).pop();
            this.value = this.value.substring(0, this.value.length-term.length) + ui.item.value + " ";
            return false;
        }
    });

    window.setInterval("checkForTimeout()", 30000);
    if (window.opera) window.setInterval("parseResponse()", 5000);
}

/** Checks the selected file for compatibility with twitter. That is
 *  *) The size is less or equal to photo_size_limit (determined by get_twitter_configuration at startup)
 *  *) The file type is acceptable (list according to twitter docs)
 */
function check_file() {
    var file = $('#file')[0].files[0];
    var error = false;
    if (file && file.fileSize>photo_size_limit) {
        alert("Die Datei ist zu groß.\n\nDateigröße:\t" + file.fileSize + " Bytes\nMaximum:\t" + photo_size_limit + " Bytes");
        error = true;
    }
    if (file && $.inArray(file.type, ["image/png", "image/gif", "image/jpeg"])==-1) {
        alert("Der Dateityp " + file.type + " wird von Twitter nicht akzeptiert.");
        error = true;
    }
    if (error) $('#file').val('');
}

/** Returns the last word of the given string. Used by autocompletion. */
function extractLast(term) {
    return term.split(/\s+/).pop();
}

/** Checks the settings object for the right version. */
function checkSettings() {
    if (typeof(settings)=="undefined") return false;
    return (settings.version == expected_settings_version);
}

/** Checks the credentials from settings.js and fills this_users_name with the screen_name of the current user. */
function validateCredentials() {
    setStatus("Validating credentials...", "yellow");
    var message = {
        action: "https://api.twitter.com/1/account/verify_credentials.json",
        method: "GET"
    }
    OAuth.setTimestampAndNonce(message);
    OAuth.completeRequest(message, settings.twitter);
    OAuth.SignatureMethod.sign(message, settings.twitter);
    var url = 'proxy/api/account/verify_credentials.json?' + OAuth.formEncode(message.parameters);
    return $.ajax({
        url: url,
        type: "GET",
        async: false,
        success: function(data, result, request) {
            if (data.screen_name) {
                this_users_name = data.screen_name;
            } else {
                addHTML("Unknown error in validateCredentials. Exiting. " + data);
            }
        },
        error: function(data, result, request) {
            addHTML("Unknown error in validateCredentials. Exiting. " + data.responseText);
        }
    });
}

/** Get twitter configuration */
function get_twitter_configuration() {
    setStatus("Getting Twitter Configuration...", "yellow");
    var message = {
        action: "https://api.twitter.com/1/help/configuration.json",
        method: "GET"
    }
    OAuth.setTimestampAndNonce(message);
    OAuth.completeRequest(message, settings.twitter);
    OAuth.SignatureMethod.sign(message, settings.twitter);
    var url = 'proxy/api/help/configuration.json?' + OAuth.formEncode(message.parameters);
    return $.ajax({
        url: url,
        type: "GET",
        async: false,
        success: function(data, result, request) {
            short_url_length = data.short_url_length;
            log_message("get_twitter_config", "short_url_length: "+data.short_url_length);
            short_url_length_https = data.short_url_length_https;
            log_message("get_twitter_config", "short_url_length_https: "+data.short_url_length_https);
            characters_reserved_per_media = data.characters_reserved_per_media;
            log_message("get_twitter_config", "characters_reserved_per_media: "+data.characters_reserved_per_media);
            max_media_per_upload = data.max_media_per_upload;
            log_message("get_twitter_config", "max_media_per_upload: "+data.max_media_per_upload);
            photo_size_limit = data.photo_size_limit;
            log_message("get_twitter_config", "photo_size_limit: "+data.photo_size_limit);
        },
        error: function(data, result, request) {
            addHTML("Unknown error in get_twitter_configuration. Exiting. " + data.responseText);
        }
    });
}

/** Asynchronously gets the IDs of all followers of the current user. */
function getFollowers() {
    var message = {
        action: "https://api.twitter.com/1/followers/ids.json",
        method: "GET"
    }
    OAuth.setTimestampAndNonce(message);
    OAuth.completeRequest(message, settings.twitter);
    OAuth.SignatureMethod.sign(message, settings.twitter);
    var url = "proxy/api/followers/ids.json?" + OAuth.formEncode(message.parameters);
    $.ajax({
        url: url,
        type: "GET",
        async: true,
        success: function(data) {
            followers_ids = data;
        }
    });
}

/**
 * Checks if a timeout in the stream occured. Gets run via timer every 30 Seconds.
 * The stream should at least send a newline every 30 seconds.
 * If this doesn't happen we assume the connection timed out and force it to be re-established.
 *
 * This code also checks for long pauses within the stream and restarts the geotweeter if necessary.
 */
function checkForTimeout() {
    var jetzt = new Date();
    if (lastDataReceivedAt && jetzt.getTime() - lastDataReceivedAt.getTime() > 30000) {
        log_message("checkForTimeout", "Timeout: No data received for the last " + (jetzt.getTime() - lastDataReceivedAt.getTime())/1000 + "seconds");
        disconnectBecauseOfTimeout = true;
        req.abort();
        return;
    }
    if (get_time_since_last_tweet() > get_timeout_difference() && $('#text').val()=='') {
        log_message("checkForTimeout", "Timeout: Lack of tweets");
        log_message("checkForTimeout", "Average Time between tweets: " + get_average_tweet_time()/1000);
        log_message("checkForTimeout", "Timeout after: " + get_timeout_difference()/1000);
        log_message("checkForTimeout", "Time since last tweet: " + get_time_since_last_tweet()/1000);
        disconnectBecauseOfTimeout = true;
        req.abort();
    }
}

/**
 * Returns the max allowed time between two tweets in seconds. Used to reconnect if
 * the stream didn't send tweets in the last time.
 */
function get_timeout_difference() {
    var delay = get_average_tweet_time()*settings.timeout_detect_factor;
    if (settings.timeout_minimum_delay*1000 > delay) return settings.timeout_minimum_delay*1000;
    if (settings.timeout_maximum_delay*1000 < delay) return settings.timeout_maximum_delay*1000;
    return delay;
}

/**
 * Returns the average time between the last x tweets.
 **/
function get_average_tweet_time() {
    if (last_event_times.length<2) return NaN;
    return (last_event_times[0] - last_event_times[last_event_times.length-1]) / (last_event_times.length-1);
}

/**
 * Returns the time since the last received tweet in milliseconds.
 */
function get_time_since_last_tweet() {
    return (Date.now() - last_event_times[0]);
}

/**
 * Requests all tweets for the timeline (non-streaming).
 * If this is the first call since start of the geotweeter, as many tweets as possible are requested.
 * Otherwise it gets called after a disconnect. Then only missed tweets are fetched.
 *
 * Queries the home_timeline and then mentions, since home_timeline doesn't contain mentions from
 * people you don't follow.
 */
function fillList() {
    log_message("fillList", "Starting");
    setStatus("Filling List. Request 1/2...", "yellow");
    var page = 1;

    var parameters = {include_rts: "1", count: 200, include_entities: true};
    if (maxknownid!="0") parameters.since_id = maxknownid;
    var message = {
        action: "https://api.twitter.com/1/statuses/home_timeline.json",
        method: "GET",
        parameters: parameters
    }
    OAuth.setTimestampAndNonce(message);
    OAuth.completeRequest(message, settings.twitter);
    OAuth.SignatureMethod.sign(message, settings.twitter);
    var url = 'proxy/api/statuses/home_timeline.json?' + OAuth.formEncode(message.parameters);
    var returned = $.ajax({
        url: url,
        type: "GET",
        async: false,
        dataType: "text"
    }).responseText;


    setStatus("Filling List. Request 2/2...", "yellow");
    message.action = "https://api.twitter.com/1/statuses/mentions.json";
    OAuth.setTimestampAndNonce(message);
    OAuth.completeRequest(message, settings.twitter);
    OAuth.SignatureMethod.sign(message, settings.twitter);
    var url = 'proxy/api/statuses/mentions.json?' + OAuth.formEncode(message.parameters);
    var returned_mentions = $.ajax({
        url: url,
        type: "GET",
        async: false,
        dataType: "text"
    }).responseText;

    parseData(returned, returned_mentions);
    last_event_times.unshift(Date.now());
    last_event_times.pop();
}
    

/** Starts a request to the streaming api. */
function startRequest() {
    log_message("startRequest", "Calling fillList()...");
    fillList();

    var message = {
        action: "https://userstream.twitter.com/2/user.json",
        method: "GET",
        parameters: {delimited: "length", include_entities: "1", include_rts: "1"}
    }

    OAuth.setTimestampAndNonce(message);
    OAuth.completeRequest(message, settings.twitter);
    OAuth.SignatureMethod.sign(message, settings.twitter);
    var url = 'user_proxy?' + OAuth.formEncode(message.parameters);
    
    setStatus("Connecting to stream...", "orange");

    disconnectBecauseOfTimeout = false;

    req = new XMLHttpRequest();
    req.open('GET', url, true);
    req.onreadystatechange = parseResponse;
    req.send(null);
    lastDataReceivedAt = new Date();
}


/**
 * Gets run by onreadystatechange of the XHR object of the streaming connection.
 * (On Opera, this doesn't work, so here we use a timer to call it every 5 seconds.
 */
function parseResponse() {
    if (!req) return;

    if (req.readyState == 1) {
        connectionStartedAt = new Date();
    } else if (req.readyState == 4) {
        setStatus("Disconnected.", "red");
        var jetzt = new Date();
        if (jetzt.getTime() - connectionStartedAt.getTime() > 10000)
            delay = settings.timings.mindelay;
        var html = '<div class="status">Disconnect. ';
        if (disconnectBecauseOfTimeout) {
            html += 'Grund: Timeout. ';
        }
        if (req.status != 200 && !disconnectBecauseOfTimeout) {
            html += 'Status: ' + req.status + ' (' + req.statusText + '). ';
            delay = settings.timings.maxdelay;
        }
        addHTML(html + 'Nächster Versuch in ' + delay + ' Sekunden.</div>');
        window.setTimeout('startRequest()', delay*1000);
        req = null;
        if (delay*2 <= settings.timings.maxdelay)
            delay = delay * 2;
    } else if (req.readyState == 3) {
        setStatus("Connected to stream.", "green");
        lastDataReceivedAt = new Date();
    }
    buffer += req.responseText.substr(responseOffset);
    responseOffset = req.responseText.length;
    if (!isProcessing) processBuffer();
}


/**
 * Processes the stream buffer. Gets new data from the end of the stream data and gives it to parseData().
 */
function processBuffer() {
    isProcessing = true;
    reg = /^[\r\n]*([0-9]+)\r\n([\s\S]+)$/;
    while(res = buffer.match(reg)) {
        len = parseInt(res[1]);
        if (res[2].length >= len) {
            parseableText = res[2].substr(0, len);
            buffer = res[2].substr(len);
            parseData(parseableText);
        } else {
            break;
        }
    }
    isProcessing = false;
}


/**
 * Get json-encoded data, parse it, determine it's type and give the object to a matching display method.
 *
 * Can take two datasets, which then get analyzed and "interleaved".
 */
function parseData(data, data2) {
    try {
        var message = $.parseJSON(data);
    } catch (e) {
        addHTML("Exception: " + e + '<br />' + data + '<hr />');
    }

    var message2 = null;
    if (data2 != undefined) try {
        message2 = $.parseJSON(data);
    } catch(e) {}
	

    if (message.constructor.toString().indexOf('Array')!=-1) {

        var html = '';
        if (message2 == null) {
            for(var i=0; i<message.length; i++) {
                if (message[i]) html += getStatusHTML(message[i], true);
            }
        } else {
            var i=0;
            var j=0;
            var last_id = null;
            while (i<message.length || j<message2.length) {
                if(!message2[j] || (message[i] && biggerThan(message[i].id, message2[j].id))) {
                    if (last_id!=message[i].id) html += getStatusHTML(message[i], true);
                    last_id = message[i].id;
                    i++;
                } else {
                    if (last_id!=message2[j].id) html += getStatusHTML(message2[j], true);
                    last_id = message2[j].id;
                    j++;
                }
            }
        }
        addHTML(html);
        return;
    }

    if (message==null)
        return; // Fix for NULLs in stream

    if (message.text) {
        addHTML(getStatusHTML(message));
    } else if (message.friends) {
        twitter_friends = message.friends;
    } else if ("delete" in message) {
        // Deletion-Request. Do nothing ,-)
    } else if (message.direct_message) {
        addHTML(getStatusHTML(message));
    } else if (message.event && message.event=="follow") {
        // Social Event.
        addFollowEvent(message);
    } else if (message.event && message.event=="favorite") {
        addFavoriteEvent(message);
    } else if (message.event && message.event=="list_member_added") {
        addListMemberAddedEvent(message);
    } else if (message.event && message.event=="list_member_removed") {
        addListMemberRemovedEvent(message);
    } else if (message.event && message.event=="block") {
        // You blocked someone. Do nothing.
    } else if (message.event && message.event=="user_update") {
        // You changed your profile settings on twitter.com. Do nothing.
    } else {
        addHTML('<hr />Unbekannte Daten:<br />' + data);
    }
}

/** 
 * Adds HTML to the DOM.
 *
 * Note: Adding the HTML to a new <div> and then append the <div> to the DOM is MUCH faster than
 * adding the HTML directly to the DOM.
 */
function addHTML(text) {
    if(text == "") return;	
	
    var elm = document.createElement("div");
    elm.innerHTML = text;
    $(elm).find('.user_avatar').tooltip({
        bodyHandler: function() {
            var par = $(this).parent().parent();
            var obj = par.find('.tooltip_info');
            var html = obj.html();
            var id = parseInt(par.attr("data-user-id"));
            if (followers_ids.indexOf(id)>=0) {
                html = html.replace(/%s/, 'folgt dir.');
            } else {
                html = html.replace(/%s/, 'folgt dir nicht.');
            }
            return html;
        },
        track: true,
        showURL: false,
        left: 5
    });
    if (settings.unshorten_links) {
        $(elm).find("a.external").tooltip({
            bodyHandler: function() {
                return unshortenLink(this.href).replace(/\//g, "<wbr>/");
            },
            track: true,
            showURL: false,
            delay: 750
        });
    }
    document.getElementById('content').insertBefore(elm, document.getElementById('content').firstChild);
}


/** Uses unshorten.me to unshorten a given URL. */
function unshortenLink(url) {
    var result = null;
    $.ajax({
        url: "proxy/unshort.me/?r=" + encodeURIComponent(url) + "&t=json",
        type: "GET",
        async: false,
        dataType: "json",
        success: function(data) { result = data; }
    });
    if(result && result.success=="true") return result.resolvedURL;
    return url;
}


/** Adds an event with custom text to the DOM. */
function addEvent(event, text) {
    var html = "";
    html += '<div class="status">';
    html += '<span class="avatar">';
    html += '<a href="http://twitter.com/account/profile_image/' + event.source.screen_name + '" target="_blank"><img class="user_avatar" src="' + event.source.profile_image_url + '" /></a>';
    html += '</span>';
    html += text;
    html += '</div>';
    addHTML(html);
}

/** Creates html for a new follower-event and adds it to the DOM via addEvent(). */
function addFollowEvent(event) {
    if (event.source.screen_name==this_users_name) return;
    var html = "";
    html += 'Neuer Follower: ';
    html += '<span class="poster">';
    html += '<a href="http://twitter.com/' + event.source.screen_name + '" target="_blank">' + event.source.screen_name + '</a> (' + event.source.name + ')';
    html += '</span>';
    followers_ids.push(event.source.id);
    addEvent(event, html);
}

/** Creates html for a favorite added-event and adds it to the DOM via addEvent(). */
function addFavoriteEvent(event) {
    if (event.source.screen_name==this_users_name) return;
    var html = "";
    html += '<span class="poster">';
    html += '<a href="http://twitter.com/' + event.source.screen_name + '" target="_blank">' + event.source.screen_name + '</a>';
    html += '</span>';
    html += ' favorisierte:<br />';
    html += linkify(event.text);
    addEvent(event, html);
}

/** Creates html for an added to list-event and adds it to the DOM via addEvent(). */
function addListMemberAddedEvent(event) {
    if (event.source.screen_name==this_users_name) return;
    var html = "";
    html += '<span class="poster">';
    html += '<a href="http://twitter.com/' + event.source.screen_name + '" target="_blank">' + event.source.screen_name + '</a>';
    html += '</span>';
    html += ' fügte dich zu einer Liste hinzu:<br />';
    html += '<a href="http://twitter.com' + event.target_object.uri + '" target="_blank">' + event.target_object.full_name + '</a> ';
    html += '(' + event.target_object.members_count + 'Members, ' + event.target_object.subscriber_count + ' Subscribers)';
    addEvent(event, html);
}

/** Creates html for a removed from list-event and adds it to the DOM via addEvent(). */
function addListMemberRemovedEvent(event) {
    if (event.source.screen_name==this_users_name) return;
    var html = "";
    html += '<span class="poster">';
    html += '<a href="http://twitter.com/' + event.source.screen_name + '" target="_blank">' + event.source.screen_name + '</a>';
    html += '</span>';
    html += ' löschte dich von einer Liste:<br />';
    html += '<a href="http://twitter.com' + event.target_object.uri + '" target="_blank">' + event.target_object.full_name + '</a> ';
    addEvent(event, html);
}


/** Creates html for a normal tweet, RT or DM. */
function getStatusHTML(status, multi_add) {
	// Check if tweet contains blacklisted words

    if (status.id_str)
        status.id = status.id_str;
    if (status.in_reply_to_status_id_str)
        status.in_reply_to_status_id = status.in_reply_to_status_id_str;
    isDM = false;
    if (status.direct_message) {
        isDM = true;
        status = status.direct_message;
    }
    if (!isDM && status.in_reply_to_status_id) {
        repliesData[status.id] = status.in_reply_to_status_id;
    }
    var html = "";
    var user;
    var user_object;
    if (status.retweeted_status)
        user_object = status.retweeted_status.user;
    else if (isDM)
        if (status.sender.screen_name == this_users_name) {
            user_object = status.recipient;
            user_object.is_receiver = true;
        } else {
            user_object = status.sender;
        }
    else
        user_object = status.user;

    user = user_object.screen_name;
    addToAutoCompletion("@" + user);

    if (!isDM && biggerThan(status.id, maxknownid))
        maxknownid = status.id;
    if (!isDM && (minknownid==0 || status.id < minknownid))
        minknownid = status.id;

    if (!isDM && user==this_users_name && biggerThan(status.id, mylasttweetid))
        mylasttweetid = status.id;

    var date = new Date(status.created_at);
    if (multi_add) {
        // Multi-Add = Tweets kommen chronologisch absteigend
        last_event_times.push(date);
    } else {
        // Stream-Add = Tweets kommen chronologisch aufsteigend
        last_event_times.unshift(date);
    }
    if (last_event_times.length > (settings.timeout_detect_tweet_count+1)) last_event_times.pop();
    var datum = addnull(date.getDate()) + '.' + addnull(date.getMonth()+1) + '.' + (date.getYear()+1900) + ' ' + addnull(date.getHours()) + ':' + addnull(date.getMinutes());
    html += '<div class="';
    if (!isDM)
        html += 'tweet ';
    else
        html += 'dm ';
    html += 'by_' + user + ' ';
    if (user == this_users_name) html += "by_this_user ";
    if (!isDM && biggerThan(status.id, maxreadid))
        html += 'new ';
    var mentions = status.text.match(regexp_user);
    if (mentions) {
        for (var i=0; i<mentions.length; i++) {
            mention = String(mentions[i]).trim().substr(1);
            html += 'mentions_' + mention + ' ';
            if (mention == this_users_name) html += "mentions_this_user ";
        }
    }
  
    
    html += '" id="id_' + status.id + '">';
    html += '<a name="status_' + status.id + '"></a>';
    html += '<span class="avatar" data-user-id="' + user_object.id + '">';

    // Start Tooltip-Info
    html += '<span class="tooltip_info">';
    html += '<strong>' + user_object.name + '</strong><br /><br />';
    html += user_object.followers_count + ' Follower<br />';
    html += user_object.friends_count + ' Friends<br />';
    html += user_object.statuses_count + ' Tweets<br /><br />';
    html += "@" + user + " %s";
    html += '</span>';
    // Ende Tooltip-Info

    html += '<a href="http://twitter.com/account/profile_image/' + user + '" target="_blank"><img class="user_avatar" src="';
    if (status.retweeted_status)
        html += status.retweeted_status.user.profile_image_url;
    else if (isDM)
        html += status.sender.profile_image_url;
    else
        html += status.user.profile_image_url;
    html += '" /></a>';
    html += '</span>';
    html += '<span class="poster">';
    var extra="";
    if (user_object.is_receiver) extra = "to ";
    html += '<a href="http://twitter.com/' + user + '" target="_blank">' + extra + user + '</a>';
    html += '</span> ';
    html += '<span class="text">';
    var temp_text = "";
    if (status.retweeted_status)
        temp_text += linkify(status.retweeted_status.text, status.retweeted_status.entities);
    else
        temp_text += linkify(status.text, status.entities);
	
	    
    	if(check_blacklist(temp_text)){
		return "";
	}
	else
	html += temp_text;
	
	
    html += '</span>';
    if (status.retweeted_status)
        html += '<div class="retweet_info">Retweeted by <a href="http://twitter.com/' + status.user.screen_name + '" target="_blank">' + status.user.screen_name + '</a></div>';
    if (status.place)
        html += '<div class="place">from <a href="http://twitter.com/#!/places/' + status.place.id + '" target="_blank">' + status.place.full_name + '</a></div>';
    html += '<div class="overlay">';
    html += '<div class="info">';
    html += '<a href="http://twitter.com/#!/' + user + '/status/' + status.id + '" target="_blank">' + datum + '</a> ';
    if(status.in_reply_to_status_id) {
        html += '<a href="#" onClick="show_replies(\'' + status.id + '\'); return false;">in reply to...</a> ';
    }
    if (status.source)
        html += 'from ' + status.source + ' ';
    html += '</div>';

    html += '<div class="links">';
    if (isDM)
        html += '<a href="#" onClick="replyToTweet(\'' + status.id + '\', \'' + user + '\', true); return false;"><img src="icons/comments.png" title="Reply" /></a>';
    else
        html += '<a href="#" onClick="replyToTweet(\'' + status.id + '\', \'' + user + '\'); return false;"><img src="icons/comments.png" title="Reply" /></a>';
    if (!isDM)
        html += '<a href="#" onClick="retweet(\'' + status.id + '\'); return false;"><img src="icons/arrow_rotate_clockwise.png" title="Retweet" /></a>';
    if (!isDM)
        html += '<a href="#" onClick="quote(\'' + status.id + '\', \'' + user + '\', \'' + escape(status.text) + '\'); return false;"><img src="icons/tag.png" title="Quote" /></a>';
    html += '<a href="http://translate.google.de/#auto|de|' + escape(status.text.split('"').join('').split('@').join('')) + '" target="_blank"><img src="icons/transmit.png" title="Translate" /></a>';
    html += '<a href="http://twitter.com/#!/' + user + '/status/' + status.id + '" target="_blank"><img src="icons/link.png" title="Permalink" /></a>';
    if (status.coordinates) {
        html += '<a href="http://maps.google.com/?q=' + status.coordinates.coordinates[1] + ',' + status.coordinates.coordinates[0] + '" target="_blank"><img src="icons/world.png" title="Geotag" /></a>';
        html += '<a href="http://maps.google.com/?q=http%3A%2F%2Fapi.twitter.com%2F1%2Fstatuses%2Fuser_timeline%2F' + user + '.atom%3Fcount%3D250" target="_blank"><img src="icons/world_add.png" title="All Geotags" /></a>';
    }
    if ( user==this_users_name) {
        html += '<a href="#" onClick="delete_tweet(\'' + status.id + '\'); return false;"><img src="icons/cross.png" title="Delete Tweet" /></a>';
    } else {
        html += '<a href="#" onClick="report_spam(\'' + user + '\'); return false;"><img src="icons/exclamation.png" title="Block and report as spam" /></a>';
    }

    html += '</div>'; // Links
    html += '</div>'; // overlay
    html += '</div>'; // tweet
    
    return html;
}

/** Adds a leading null to numbers less than 10. */
function addnull(number) {
    if (number<10)
        return "0" + number;
    return number;
}

/** Sort funtion for an array containing entities */
function entity_sort(a, b) {
    return a.indices[0] - b.indices[0];
}

/** Offset-based string replacement function for use with entity indices */
function replace_entity(str, replace, entity) {
    var result = str.slice(0, entity.indices[0]) + replace + str.slice(entity.indices[1]);
    return result;
}

/** Adds hyperlinks to URLs, Twitternicks, Hastags and GC-Codes. */
function linkify(text, entities) {
    if (entities) {
        var all_entities = new Array();
        for (var entity_type in entities) {
            for (var i=0; i<entities[entity_type].length; i++) {
                var entity = entities[entity_type][i];
                entity.type = entity_type;
                all_entities.push(entity);
            }
        }
        var all_entities_sort = all_entities.sort(entity_sort).reverse();
        for (var i=0; i<all_entities_sort.length; i++) {
            entity = all_entities_sort[i];
            if (entity.type=="user_mentions") {
                text = replace_entity(text, '<a href="https://twitter.com/' + entity.screen_name + '" target="_blank">@' + entity.screen_name + '</a>', entity);
                addToAutoCompletion('@' + entity.screen_name);
            } else if (entity.type=="urls") {
                if (entity.expanded_url) {
                    text = replace_entity(text, '<a href="' + entity.expanded_url + '" class="external" target="_blank">' + entity.display_url + '</a>', entity);
                } else {
                    text = replace_entity(text, '<a href="' + entity.url + '" class="external" target="_blank">' + entity.url + '</a>', entity);
                }
            } else if (entity.type=="hashtags") {
                text = replace_entity(text, '<a href="http://twitter.com/search?q=#' + entity.text + '" target="_blank">#' + entity.text + '</a>', entity);
                addToAutoCompletion('#' + entity.text);
            } else if (entity.type=="media") {
                text = replace_entity(text, '<a href="' + entity.expanded_url + '" class="external" target="_blank">' + entity.display_url + '</a>', entity);
            }
        }

    } else {
        // We got no entities. This can happen with status messages and so on.
        // In that case we use the old regexp-based replacement method.
        var matches = text.match(regexp_user);
        if (matches) for (var i=0; i<matches.length; i++) {
            addToAutoCompletion(matches[i].trim());
        }

        var matches = text.match(regexp_hash);
        if (matches) for (var i=0; i<matches.length; i++) {
            addToAutoCompletion(matches[i].trim());
        }

        text = text.replace(regexp_url, '<a href="$1" target="_blank" class="external">$1</a>');
        text = text.replace(regexp_user, '$1@<a href="http://twitter.com/$2" target="_blank">$2</a>');
        text = text.replace(regexp_hash, '$1<a href="http://twitter.com/search?q=#$2" target="_blank">#$2</a>');
    }
    
    // Add Links to geocaching.com and "properly" display linebreaks.
    text = text.replace(regexp_cache, '$1<a href="http://coord.info/$2" target="_blank">$2</a>');
    text = text.replace(/\n/g, '<br />\n');
    return text;
}

/** Shows a "fullscreen" element with defined title and content. */
function infoarea_show(title, content) {
    $('#infoarea_title').html(title);
    $('#infoarea_content').html(content);
    $('#infoarea').show();
}

/** Closes the infoarea view displayed by infoarea_show() */
function infoarea_close() {
    $('#infoarea').hide();
}

/** Shows the conversation leading to a given tweet. */
function show_replies(id) {
    var html = "";

    // Quelle als erstes anzeigen
    html += $('#id_' + id).fullhtml();

    while (repliesData[id]) {
        id = repliesData[id];
        if($('#id_' + id).length>0)
            html += $('#id_' + id).fullhtml();
        else
            html += '<a href="http://twitter.com/#!/user/status/' + id + '" target="_blank">Show next status</a>';
    }

    infoarea_show("Replies", html);
}

function toggle_file(force_hide) {
    show_file_field = !show_file_field;
    if (force_hide) show_file_field=false;
    $('#file_div').toggle(show_file_field);
    if (!show_file_field) {
        $('#file').val('');
    }
}

/** Shows some stats */
function show_stats() {
    var html = "";
    html += "<strong>Anzahl Tweets:</strong>        " + $('.tweet').length + "<br />";
    html += "<strong>Verbunden seit:</strong>       " + connectionStartedAt + "<br />";
    html += "<strong>Bekannte Follower:</strong>    " + followers_ids.length + "<br />";
    html += "<strong>Buffer-Größe:</strong>         " + responseOffset + "<br />";
    
    html += "<strong>Aktuelle Zeit zwischen Tweets:</strong> " + get_average_tweet_time()/1000 + " Sekunden<br />";
    html += "<strong>Neustart nach letztem Tweet nach:</strong> " + get_timeout_difference()/1000 + " Sekunden<br />";
    html += "<strong>Letzter Tweet vor:</strong> " + get_time_since_last_tweet()/1000 + " Sekunden";

    infoarea_show("Stats", html);
}

/** 
 * Get called when the user clicks the "Tweet" button. Does not actually send the tweet,
 * but calls _sendTweet(), which does.
 */
function sendTweet(event) {
    if (event) event.preventDefault();
    if(settings.show_error_if_no_place_is_set && settings.places.length>0 && document.tweet_form.place.options[0].selected && !confirm('Kein Ort gesetzt. Wirklich ohne Koordinaten tweeten?'))
        return;

    var text = $('#text').val();
    
    var parts = splitTweet(text);

    if (parts.length==1) {
        _sendTweet(parts[0], true);
    } else {
        for (var i=0; i<parts.length; i++) {
            if (_sendTweet(parts[i])) {
                /* Tweet wurde erfolgreich gesendet */
                if (i == (parts.length-1)) {
                    /* Es war der letzte oder einzige Teil des Tweets */
                    $('#text').val('');
                    reply_to_user = null;
                    reply_to_id = null;
                    updateCounter();
                }
            } else {
                /* Tweet konnte nicht abgesendet werden */
                /* Neuen String bauen... */
                text = "";
                for (var j=i; j<parts.length; j++) {
                    text += parts[j] + ' ';
                }
                $('#text').val(text);
                break;
            }
        }
    }
    return false;
}

/** Send a tweet. Depending on the parameter async, this happens asynchronously or synchronously.
 * Asynchronously is used, if there's just one tweet to send.
 * Synchronously, if there are multiple tweets (a long, splitted tweet).
 */
function _sendTweet(text, async) {
    if (async==undefined) async=false;
    var parameters = {
        status: text,
        wrap_links: true
    };
    if (settings.places.length>0) {
        placeIndex = document.tweet_form.place.value;
        if(placeIndex > 0) {
            // Substract placeIndex by one:
            // The first index in the HTML is the "empty" place, which has id 0.
            // The elements in the places-array begin with 0, too, so in the HTML they got their id plus one.
            placeIndex--;
            parameters.lat = settings.places[placeIndex].lat + (((Math.random()*300)-15)*0.000001);
            parameters.lon = settings.places[placeIndex].lon + (((Math.random()*300)-15)*0.000001);
            if (settings.places[placeIndex].place_id)
                parameters.place_id = settings.places[placeIndex].place_id;
            parameters.display_coordinates = "true";
        }
    }
    if (document.tweet_form.reply_to_id.value != "")
        parameters.in_reply_to_status_id = document.tweet_form.reply_to_id.value;
    
    var message; 
    var url;
    var data;
    var content_type = 'application/x-www-form-urlencoded';

    $('#form').fadeTo(500, 0).delay(500);

    if ($('#file')[0].files[0]) {
        // Es ist ein Bild vorhanden, das hochgeladen werden soll.

        message = {
            action: "https://upload.twitter.com/1/statuses/update_with_media.json",
            method: "POST"
        }

        OAuth.setTimestampAndNonce(message);
        OAuth.completeRequest(message, settings.twitter);
        OAuth.SignatureMethod.sign(message, settings.twitter);

        url = 'proxy/upload/statuses/update_with_media.json?' + OAuth.formEncode(message.parameters);
        content_type = false;

        data = new FormData();
        data.append("media[]", $('#file')[0].files[0]);

        for (var key in parameters) {
            data.append(key, parameters[key]);
        }

    } else {
        message = {
            action: "https://api.twitter.com/1/statuses/update.json",
            method: "POST",
            parameters: parameters
        }
        url = "proxy/api/statuses/update.json";
        
        OAuth.setTimestampAndNonce(message);
        OAuth.completeRequest(message, settings.twitter);
        OAuth.SignatureMethod.sign(message, settings.twitter);

        data = OAuth.formEncode(message.parameters);
    }

    var req = $.ajax({
        url: url,
        data: data,
        processData: false,
        contentType: content_type,
        async: async,
        dataType: "json",
        type: "POST",
        success: function(data, textStatus, req) {
            if (data.text) {
                //$('#counter').html(data + textStatus);
                var html = 'Tweet-ID: ' + data.id_str + '<br />';
                html += 'Mein Tweet Nummer: ' + data.user.statuses_count + '<br />';
                html += 'Follower: ' + data.user.followers_count + '<br />';
                html += 'Friends:' + data.user.friends_count + '<br />';

                if (async) {
                    $('#text').val('');
                    reply_to_user = null;
                    reply_to_id = null;
                    updateCounter();
                }

                toggle_file(true);
                $('#success_info').html(html);
                $('#success').fadeIn(500).delay(2000).fadeOut(500, function() {
                    $('#form').fadeTo(500, 1);
                });
            } else {
                $('#failure_info').html(data.error);
                $('#failure').fadeIn(500).delay(2000).fadeOut(500, function() {
                    $('#form').fadeTo(500, 1);
                });
            }
        },
        error: function(req, testStatus, exc) {
            $('#failure_info').html('Error ' + req.status + ' (' + req.statusText + ')');
            $('#failure').fadeIn(500).delay(2000).fadeOut(500, function() {
                $('#form').fadeTo(500, 1);
            });
        }
   });
   // if we're running asynchronously, we have to return false to prevent the browser from reloading
   // the current page.
   // I don't know why this happens, probably because some weird Javascript-Foo... *sigh*
   if (async) return false;
   return req.status==200;
}

/** Splits a tweet at the tweetSeperator, but maintains mentions for all parts. */
function splitTweet(text) {
    var mention = text.match(/^(((@[a-z0-9_]+) +)+)/i);
    var words = text.split(' ');
    var word;

    var parts = text.split(settings.tweetSeperator.seperator);
    for (var i=0; i<parts.length; i++) {
        parts[i] = parts[i].trim();
        if (mention && i>0) parts[i] = mention[1].trim() + ' ' + parts[i];
    }
    return parts;
}

/** Natively retweets a given tweet. */
function retweet(id) {
    if (!confirm('Wirklich direkt retweeten?'))
        return false;

    var message = {
        action: "https://api.twitter.com/1/statuses/retweet/" + id + ".json",
        method: "POST"
    }

    $('#form').fadeTo(500, 0).delay(500);
    
    OAuth.setTimestampAndNonce(message);
    OAuth.completeRequest(message, settings.twitter);
    OAuth.SignatureMethod.sign(message, settings.twitter);
    var url = 'proxy/api/statuses/retweet/' + id + '.json';
    var data = OAuth.formEncode(message.parameters);

    $.ajax({
        url: url,
        data: data,
        dataType: "json",
        type: "POST",
        success: function(data, textStatus, req) {
            if (req.status==200) {
                $('#success_info').html("Retweet successful");
                $('#success').fadeIn(500).delay(5000).fadeOut(500, function() {
                    $('#form').fadeTo(500, 1);
                });
            } else {
                $('#failure_info').html(data.error);
                $('#failure').fadeIn(500).delay(2000).fadeOut(500, function() {
                    $('#form').fadeTo(500, 1);
                });
            }
            updateCounter();
        },
        error: function(req, testStatus, exc) {
            $('#failure_info').html('Error ' + req.status + ' (' + req.statusText + ')');
            $('#failure').fadeIn(500).delay(2000).fadeOut(500, function() {
                $('#form').fadeTo(500, 1);
            });
        }
   });
}

/** Delete one of your own tweets. */
function delete_tweet(id) {
    if (!confirm('Wirklich diesen Tweet löschen?'))
        return false;

    var message = {
        action: "https://api.twitter.com/1/statuses/destroy/" + id + ".json",
        method: "POST"
    }

    $('#form').fadeTo(500, 0).delay(500);
    
    OAuth.setTimestampAndNonce(message);
    OAuth.completeRequest(message, settings.twitter);
    OAuth.SignatureMethod.sign(message, settings.twitter);
    var url = 'proxy/api/statuses/destroy/' + id + '.json';
    var data = OAuth.formEncode(message.parameters);

    $.ajax({
        url: url,
        data: data,
        dataType: "json",
        type: "POST",
        success: function(data, textStatus, req) {
            if (req.status==200) {
                $('#success_info').html("Tweet deleted");
                $('#id_' + id).remove();
                $('#success').fadeIn(500).delay(5000).fadeOut(500, function() {
                    $('#form').fadeTo(500, 1);
                });
            } else {
                $('#failure_info').html(data.error);
                $('#failure').fadeIn(500).delay(2000).fadeOut(500, function() {
                    $('#form').fadeTo(500, 1);
                });
            }
            updateCounter();
        },
        error: function(req, testStatus, exc) {
            $('#failure_info').html('Error ' + req.status + ' (' + req.statusText + ')');
            $('#failure').fadeIn(500).delay(2000).fadeOut(500, function() {
                $('#form').fadeTo(500, 1);
            });
        }
   });
}

/** Delete one of your own tweets. */
function report_spam(sender_name) {
    if (!confirm('Wirklich ' + sender_name + ' als Spammer melden?'))
        return false;

    var message = {
        action: "https://api.twitter.com/1/report_spam.json",
        method: "POST",
        parameters : {screen_name: sender_name}
    }

    $('#form').fadeTo(500, 0).delay(500);
    
    OAuth.setTimestampAndNonce(message);
    OAuth.completeRequest(message, settings.twitter);
    OAuth.SignatureMethod.sign(message, settings.twitter);
    var url = 'proxy/api/report_spam.json';
    var data = OAuth.formEncode(message.parameters);

    $.ajax({
        url: url,
        data: data,
        dataType: "json",
        type: "POST",
        success: function(data, textStatus, req) {
            if (req.status==200) {
                $('#success_info').html("Spam gemeldet.");
                $('.by_' + sender_name).remove();
                $('#success').fadeIn(500).delay(5000).fadeOut(500, function() {
                    $('#form').fadeTo(500, 1);
                });
            } else {
                $('#failure_info').html(data.error);
                $('#failure').fadeIn(500).delay(2000).fadeOut(500, function() {
                    $('#form').fadeTo(500, 1);
                });
            }
            updateCounter();
        },
        error: function(req, testStatus, exc) {
            $('#failure_info').html('Error ' + req.status + ' (' + req.statusText + ')');
            $('#failure').fadeIn(500).delay(2000).fadeOut(500, function() {
                $('#form').fadeTo(500, 1);
            });
        }
   });
}

/** Quotes a tweet (using the old "RT" syntax). */
function quote(tweet_id, user, text) {
    text = 'RT @' + user + ': ' + unescape(text);
    reply_to_user = user;
    reply_to_id = tweet_id;
    $('#text').val(text).focus();
    $('#reply_to_id').val(tweet_id);
    updateCounter();
}

/** 
 * Prepares the form to reply to a tweet.
 * Prefills the textarea with "@user ", sets in_reply_to_id and sets the focus to the textarea.
 */
function replyToTweet(tweet_id, user, isDM) {
    reply_to_user = user;
    reply_to_id = tweet_id;
    $('#text').focus();
    $('#text').val('');
    if (isDM===true)
        $('#text').val('d ' + user + ' ').focus();
    else
        $('#text').val('@' + user + ' ').focus();
    $('#reply_to_id').val(tweet_id);
    updateCounter();
}

/** Gets the length of the tweet, remaining chars to twitter's 140 char limit and displays it. */
function updateCounter() {
    var text = $('#text').val();
    var parts = splitTweet(text);

    var lengths = "";
    var color = "#0b0";
    if (parts.length==0)
        lengths = "140+";
    for (var i=0; i<parts.length; i++) {
        var text = parts[i];
        var dm_match = text.match(/^d \w+ (.*)$/i);
        if (dm_match) {
            text = dm_match[1];
        }
        var len = 140 - text.length;
        if ($('#file')[0].files[0]) len -= characters_reserved_per_media;
        var matches = text.match(regexp_url);
        if (matches) for (var i=0; i<matches.length; i++) {
            var m = matches[i].trim();
            if (m.length < short_url_length) continue;
            len += m.length;
            if (m.slice(0, 5)=="https") len -= short_url_length_https;
            else len -= short_url_length;
        }
        if (len<0) color="#f00";
        lengths += len+'+';
    }
    lengths = lengths.substr(0, lengths.length-1);
        
    $('#counter').html(lengths);
    $('#counter').css("color", color);

    if (reply_to_id != null) {
        var re = new RegExp("(^| )@" + reply_to_user + "([\.:, ]|$)");
        if (re.test(text)) {
            $('#reply_warning').fadeOut();
        } else {
            $('#reply_warning').fadeIn();
        }
    } else {
        $('#reply_to_id').val('');
        $('#reply_warning').fadeOut();
    }
}

/** 
 * Gets called if the user removed a mention and klicked the link in the appearing warning message.
 * Especially removes the in_reply_to_id value.
 */
function removeReplyWarning() {
    $('#reply_to_id').val('');
    $('#reply_warning').fadeOut();
    reply_to_user = null;
    reply_to_id = null;
}

/** Gets the max read ID from the server. */
function getMaxReadID() {
    value = $.ajax({
        method: 'GET',
        url: 'maxreadid/get.php',
        async: false,
        dataType: 'text'
    }).responseText;
    log_message("getMaxReadID", "result: " + value);
    return value;
}

/** Sets the max read ID on the server. */
function setMaxReadID(id) {
    $.ajax({
        method: 'GET',
        url: 'maxreadid/set.php',
        async: false,
        dataType: 'text',
        data: {id: id}
    });
}

/** Sets the max read ID by using setmaxReadID and marks all tweets as read. */
function markAllRead() {
    if (maxknownid > 0)
        setMaxReadID(maxknownid);
    maxreadid = maxknownid;
    $('.new').removeClass('new');
}

/** Scrolls to the last tweet written by the current user. */
function goToMyLastTweet() {
    if (mylasttweetid > 0)
        scrollTo(mylasttweetid);
}

/** Scrolls to a tweet specified by it's id. */
function scrollTo(tweet_id) {
    // Jump to the tweet's anchor
    self.location = '#status_' + tweet_id;

    // The selected tweet is now behind the form-overlay, so we need to scroll back up a little bit.
    // The padding-top of the content-area equals the height of the overlay, so we use that.
    var top = $("html").scrollTop();
    var topheight = parseInt($('#content').css("padding-top"));
    $("html").scrollTop(top - topheight);
}

/** Sets a status message. The colors are actually class names. */
function setStatus(message, color) {
    $("#status").text(message).removeClass().addClass(color);
}

/** Scrolls down to the last read tweet. */
function goToLastRead(){
    scrollTo(maxreadid);
}

/** Check the time between two presses of Enter and send the tweet if the time is lower than settings.timings.max_double_enter_time. */
function checkEnter(event) {
    var d = new Date();
    if (d.getTime() - timeOfLastEnter <= settings.timings.max_double_enter_time) {
        if (event) event.preventDefault();
        $('#text').val(textBeforeEnter);
        sendTweet();
    }
    textBeforeEnter = $('#text').val();
    timeOfLastEnter = d.getTime();
}

/** Compares two number-strings. True, if a is bigger than b. Else returns false. */
function biggerThan(a, b) {
    var l1 = a.length;
    var l2 = b.length;
    if (l1>l2) return true;
    if (l1<l2) return false;
    return a>b;
}

/** Checks for blacklisted words. */
function check_blacklist(text){
    for (var i=0; i<settings.blacklist.length; i++)
    {
        if(text.indexOf(settings.blacklist[i]) != -1)
            return true;
    }
    return false;
}

/** Adds a term to the list of usable autocompletions. */
function addToAutoCompletion(term) {
    if ($.inArray(term, autocompletes)==-1) {
        autocompletes.push(term);
        autocompletes.sort();
    }
}

/** Adds an entry to the debug log if enabled in settings.js. */
function log_message(place, s) {
    if (settings.debug && console) {
        var str = "[ " + place;
        for(var i=0; i<(20-place.length); i++) str += " ";
        str += " ] " + s;
        console.log(str);
     }
}
