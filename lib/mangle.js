"use strict";
/* global global, self, console */

import {
    push_uniq,
} from "./utils/index.js";
import { base54 } from "./scope";
import {
    AST_Conditional,
    AST_NameMapping,       
    AST_ObjectKeyVal,
    AST_ObjectProperty,
    AST_PropAccess,        
    AST_Sequence,
    AST_String,
    AST_Sub,
    AST_Symbol, 
    TreeTransformer,
    TreeWalker,    
} from "./ast.js";

import { domprops } from "../tools/domprops.js";

export function mapDifference(mapA, mapB) {
    var _difference = new Map(mapA);
    var i = 0;    
    for (var [key,_] of mapB) {
        _difference.delete(key);
        i++;
    }
    
    return _difference;
}

export function cacheCopy(cache) {
    var map = new Map();
    map.props = new Map(cache.props);
    map.exports = new Map(cache.exports);
    return map;
}

export function find_builtins(reserved) {
    domprops.forEach(add);

    // Compatibility fix for some standard defined globals not defined on every js environment
    var new_globals = ["Symbol", "Map", "Promise", "Proxy", "Reflect", "Set", "WeakMap", "WeakSet"];
    var objects = {};
    var global_ref = typeof global === "object" ? global : self;

    new_globals.forEach(function (new_global) {
        objects[new_global] = global_ref[new_global] || new Function();
    });

    // NaN will be included due to Number.NaN
    [
        "null",
        "true",
        "false",
        "Infinity",
        "-Infinity",
        "undefined",
    ].forEach(add);
    [ Object, Array, Function, Number,
      String, Boolean, Error, Math,
      Date, RegExp, objects.Symbol, ArrayBuffer,
      DataView, decodeURI, decodeURIComponent,
      encodeURI, encodeURIComponent, eval, EvalError,
      Float32Array, Float64Array, Int8Array, Int16Array,
      Int32Array, isFinite, isNaN, JSON, objects.Map, parseFloat,
      parseInt, objects.Promise, objects.Proxy, RangeError, ReferenceError,
      objects.Reflect, objects.Set, SyntaxError, TypeError, Uint8Array,
      Uint8ClampedArray, Uint16Array, Uint32Array, URIError,
      objects.WeakMap, objects.WeakSet
    ].forEach(function(ctor) {
        Object.getOwnPropertyNames(ctor).map(add);
        if (ctor.prototype) {
            Object.getOwnPropertyNames(ctor.prototype).map(add);
        }
    });
    function add(name) {
        reserved.add(name);
    }
}

export function reserve_quoted_keys(ast, reserved) {
    function add(name) {
        push_uniq(reserved, name);
    }

    ast.walk(new TreeWalker(function(node) {
        if (node instanceof AST_ObjectKeyVal && node.quote) {
            add(node.key);
        } else if (node instanceof AST_ObjectProperty && node.quote) {
            add(node.key.name);
        } else if (node instanceof AST_Sub) {
            addStrings(node.property, add);
        }
    }));
}

export function addStrings(node, add, mangle) {
    node.walk(new TreeWalker(function(node) {
        if (node instanceof AST_Sequence) {
            addStrings(node.tail_node(), add, mangle);
        } else if (node instanceof AST_String) {
            add(node.value, mangle);
        } else if (node instanceof AST_Conditional) {
            addStrings(node.consequent, add, mangle);
            addStrings(node.alternative, add, mangle);
        }
        return true;
    }));
}

export function expressionName(node) {    
    if (node instanceof AST_Symbol) {        
        return node.name;
    } else if (node instanceof AST_PropAccess) {        
        return node.property;
    } else if (node instanceof AST_ObjectKeyVal) {
        return node.key;
    } else if (node instanceof AST_ObjectProperty) {
        return node.key.name;
    } else if (node instanceof AST_NameMapping) {
        return expressionName(node.foreign_name);
    } else {
        return null;
    }    
}

export function setExpressionName(node, value) {    
    if (node instanceof AST_Symbol) {
        var def = node.definition();
        if (def) {
            def.mangled_name = value;
        } else {
            node.name = value;
        }                            
    } else if (node instanceof AST_PropAccess) {        
        node.property = value;
    } else if (node instanceof AST_ObjectKeyVal) {
        node.key = value;
    } else if (node instanceof AST_ObjectProperty) {
        node.key.name = value;
    } else if (node instanceof AST_NameMapping) {
        setExpressionName(node.foreign_name, value);
    } else {
        console.log("Unknown type '" + node.__proto__.TYPE + "'");     
    }    
}

export function DEBUG(msg, verbose) {
    if (verbose) console.log(msg);
}

export function mangle_helpers(options, reserved, cache) {

    var cname = -1;
    var regex = options.regex && new RegExp(options.regex);

    if (reserved === undefined) {
        reserved = new Set();
    }

    // note debug is either false (disabled), a string of the debug suffix to use (enabled),
    // or an object with prefix and suffix properties (enabled).
    // note debug may be enabled as an empty string, which is falsey. Also treat passing 'true'
    // the same as passing an empty string.
    var debug = options.debug !== false;
    var debug_name_suffix;
    var debug_name_prefix;
    if (debug) {

        if (typeof(options.debug) == "object")
            debug_name_prefix = options.debug.prefix;
        else
            debug_name_prefix = "_$";

        if (typeof(options.debug) == "object")
            debug_name_suffix = options.debug.suffix;
        else
            debug_name_suffix = (options.debug === true ? "$_" : "$" + options.debug + "_");
    }

    if (cache) {
        cache.forEach(function(mangled_name) {
            reserved.add(mangled_name);
        });
    } else {
        cache = new Map();
    }

    var included = null;
    if (Array.isArray(options.included)) {
        included = new Set(options.included);
    }
    
    var names_to_mangle = new Set();
    var unmangleable = new Set();    

    var keep_quoted_strict = options.keep_quoted === "strict";
    var verbose = options.verbose;

    // only function declarations after this line

    function can_mangle(name) {
        if (unmangleable.has(name)) return false;        
        if (reserved.has(name)) return false;        
        if (options.only_cache) {            
            return cache.has(name);
        }
        //should not have a '.' - this would not ever be a valid property
        if (/[\. \-\:\[\]]/.test(name)) return false;        
        //should not be a number
        if (/^-?[0-9]+(\.[0-9]+)?(e[+-][0-9]+)?$/.test(name)) return false;
        if (included && !included.has(name)) return false;
        if (included && included.has(name)) {
            DEBUG("included name found: " + name, verbose);
        }        
        return true;
    }

    function should_mangle(name) {
        if (regex && !regex.test(name)) return false;
        if (reserved.has(name)) return false;
        if (included && !included.has(name)) return false;        
        return cache.has(name)
            || names_to_mangle.has(name);
    }

    function add(name, mangle) {
        if (mangle) {
            if (can_mangle(name))
                names_to_mangle.add(name);

            if (!should_mangle(name)) {
                unmangleable.add(name);
            }
        } else {
            //add the key to unmangleable list and cache
            unmangleable.add(name);
            if (cache.has(name)) {
                //reverse any previous mangling in a future post processing step
                cache.set(cache.get(name), name);
            }
            cache.set(name, name);
            //remove the key from mangle list if it was previously added
            names_to_mangle.delete(name);
        }
    }

    function mangle(name) {
        if (!should_mangle(name)) {
            return name;
        }

        var mangled = cache.get(name);
        if (!mangled) {
            if (debug) {
                // debug mode: use a prefix and suffix to preserve readability, e.g. o.foo -> o._$foo$NNN_.
                var debug_mangled = debug_name_prefix + name + debug_name_suffix;

                if (can_mangle(debug_mangled)) {
                    mangled = debug_mangled;
                }
            }

            // either debug mode is off, or it is on and we could not use the mangled name
            if (!mangled) {
                do {
                    mangled = base54(++cname);
                } while (!can_mangle(mangled));
            }

            cache.set(name, mangled);
        }
        return mangled;
    }

    function mangleStrings(node) {
        return node.transform(new TreeTransformer(function(node) {
            if (node instanceof AST_Sequence) {
                var last = node.expressions.length - 1;
                node.expressions[last] = mangleStrings(node.expressions[last]);
            } else if (node instanceof AST_String) {
                node.value = mangle(node.value);
            } else if (node instanceof AST_Conditional) {
                node.consequent = mangleStrings(node.consequent);
                node.alternative = mangleStrings(node.alternative);
            }
            return node;
        }));
    }

    return {
        mangleStrings,
        mangle,
        add,
        debug_name_prefix,
        debug_name_suffix,
        keep_quoted_strict,
        cache,
        names_to_mangle        
    };
}