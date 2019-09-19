"use strict";
/* eslint-env browser, es6, node */

import {
    defaults,
    map_from_object,
    map_to_object,
    HOP,
} from "./utils/index.js";
import {
    AST_Node,
    AST_Toplevel,
} from "./ast.js";
import { parse } from "./parse.js";
import { OutputStream } from "./output.js";
import { Compressor } from "./compress/index.js";
import { base54 } from "./scope.js";
import { SourceMap } from "./sourcemap.js";
import {
    mangle_properties,
    reserve_quoted_keys,
} from "./propmangle.js";
import {
    mangle_exports,    
} from "./exportmangle.js";
import {
    DEBUG
} from "./mangle.js";
var to_ascii = typeof atob == "undefined" ? function(b64) {
    return Buffer.from(b64, "base64").toString();
} : atob;
var to_base64 = typeof btoa == "undefined" ? function(str) {
    return Buffer.from(str).toString("base64");
} : btoa;

function read_source_map(code) {
    var match = /(?:^|[^.])\/\/# sourceMappingURL=data:application\/json(;[\w=-]*)?;base64,([+/0-9A-Za-z]*=*)\s*$/.exec(code);
    if (!match) {
        AST_Node.warn("inline source map not found");
        return null;
    }
    return to_ascii(match[2]);
}

function set_shorthand(name, options, keys) {
    if (options[name]) {
        keys.forEach(function(key) {
            if (options[key]) {
                if (typeof options[key] != "object") options[key] = {};
                if (!(name in options[key])) options[key][name] = options[name];
            }
        });
    }
}

function init_cache(cache) {
    if (!cache) return;
    if (!("props" in cache)) {
        cache.props = new Map();
    } else if (!(cache.props instanceof Map)) {
        cache.props = map_from_object(cache.props);
    }
    if (!("exports" in cache)) {
        cache.exports = new Map();
    } else if (!(cache.exports instanceof Map)) {
        cache.exports = map_from_object(cache.exports);
    }
}

function to_json(cache) {
    return {
        props: map_to_object(cache.props)
    };
}

function minify(files, options) {
    var warn_function = AST_Node.warn_function;
    try {
        options = defaults(options, {
            compress: {},
            ecma: undefined,
            enclose: false,
            ie8: false,
            keep_classnames: undefined,
            keep_fnames: false,
            mangle: {},
            postprocess: null,
            module: false,
            nameCache: null,
            output: {},
            parse: {},
            rename: undefined,
            safari10: false,
            sourceMap: false,
            timings: false,
            toplevel: false,
            warnings: false,
            wrap: false,
            verbose: false,
        }, true);
        var timings = options.timings && {
            start: Date.now()
        };
        if (options.keep_classnames === undefined) {
            options.keep_classnames = options.keep_fnames;
        }
        if (options.rename === undefined) {
            options.rename = options.compress && options.mangle;
        }
        set_shorthand("ecma", options, [ "parse", "compress", "output" ]);
        set_shorthand("ie8", options, [ "compress", "mangle", "output" ]);
        set_shorthand("keep_classnames", options, [ "compress", "mangle" ]);
        set_shorthand("keep_fnames", options, [ "compress", "mangle" ]);
        set_shorthand("module", options, [ "parse", "compress", "mangle" ]);
        set_shorthand("safari10", options, [ "mangle", "output" ]);
        set_shorthand("toplevel", options, [ "compress", "mangle" ]);
        set_shorthand("warnings", options, [ "compress" ]);
        var quoted_props;
        var cache;
        if (options.mangle) {
            options.mangle = defaults(options.mangle, {
                cache: options.nameCache && (options.nameCache.vars || {}),
                eval: false,
                ie8: false,
                keep_classnames: false,
                keep_fnames: false,
                module: false,
                exports: false,
                postprocess: false,
                properties: false,
                reserved: [],
                safari10: false,
                toplevel: false,
                verbose: options.verbose
            }, true);            
            init_cache(options.mangle.cache);
            if (options.mangle.properties) {
                if (typeof options.mangle.properties != "object") {
                    options.mangle.properties = {};
                }
                if (options.mangle.properties.keep_quoted) {
                    quoted_props = options.mangle.properties.reserved;
                    if (!Array.isArray(quoted_props)) quoted_props = [];
                    options.mangle.properties.reserved = quoted_props;
                }
                if (options.nameCache && !("cache" in options.mangle.properties)) {
                    cache = options.mangle.properties.cache = options.nameCache.props || {};
                }
                init_cache(options.mangle.properties.cache);
            }
            if (options.mangle.exports) {
                if (typeof options.mangle.exports != "object") {
                    options.mangle.exports = {};
                }
                if (options.nameCache && !("cache" in options.mangle.exports)) {
                    //share cache between properties and exports if possible
                    cache = options.mangle.exports.cache = cache || options.nameCache.props || {};
                }
                init_cache(options.mangle.exports.cache);  
                // share the reserved properties 
                if (options.mangle.properties) {
                    options.mangle.exports.reserved = options.mangle.properties.reserved;
                }
            }                                     
        }
        if (options.postprocess) {
            if (typeof options.postprocess != "object") {
                options.postprocess = {};
            }
            if (options.postprocess.mangle) {
                if (options.nameCache && !("cache" in options.postprocess.mangle)) {
                    //share cache between properties and exports if possible
                    cache = options.postprocess.mangle.cache = cache || options.nameCache.props || {};
                }
                init_cache(options.postprocess.mangle.cache);                
            }
        }
        if (options.sourceMap) {
            options.sourceMap = defaults(options.sourceMap, {
                asObject: false,
                content: null,
                filename: null,
                includeSources: false,
                root: null,
                url: null,
            }, true);
        }
        var warnings = [];
        if (options.warnings && !AST_Node.warn_function) {
            AST_Node.warn_function = function(warning) {
                warnings.push(warning);
            };
        }
        if (timings) timings.parse = Date.now();
        var toplevel;
        if (files instanceof AST_Toplevel) {
            toplevel = files;
        } else {
            if (typeof files == "string") {
                files = [ files ];
            }
            options.parse = options.parse || {};
            options.parse.toplevel = null;
            for (var name in files) if (HOP(files, name)) {
                options.parse.filename = name;
                options.parse.toplevel = parse(files[name], options.parse);
                if (options.sourceMap && options.sourceMap.content == "inline") {
                    if (Object.keys(files).length > 1)
                        throw new Error("inline source map only works with singular input");
                    options.sourceMap.content = read_source_map(files[name]);
                }
            }
            toplevel = options.parse.toplevel;
        }
        if (quoted_props && options.mangle.properties.keep_quoted !== "strict") {
            reserve_quoted_keys(toplevel, quoted_props);
        }
        if (options.wrap) {
            toplevel = toplevel.wrap_commonjs(options.wrap);
        }
        if (options.enclose) {
            toplevel = toplevel.wrap_enclose(options.enclose);
        }
        if (timings) timings.rename = Date.now();
        // disable rename on harmony due to expand_names bug in for-of loops
        // https://github.com/mishoo/UglifyJS2/issues/2794
        if (0 && options.rename) {
            toplevel.figure_out_scope(options.mangle);
            toplevel.expand_names(options.mangle);
        }
        if (timings) timings.compress = Date.now();
        if (options.compress) toplevel = new Compressor(options.compress).compress(toplevel);
        if (timings) timings.scope = Date.now();
        if (options.mangle) toplevel.figure_out_scope(options.mangle);
        if (timings) timings.mangle = Date.now();
        if (timings) timings.properties = Date.now();
        if (options.mangle) {
            if (options.mangle.exports) {            
                toplevel = mangle_exports(toplevel, options.mangle.exports, options.mangle.verbose);            
            }
            if (options.mangle.properties) {            
                toplevel = mangle_properties(toplevel, options.mangle.properties, options.mangle.verbose);            
            }            
        }
        if (options.postprocess && options.postprocess.mangle) {
            // keep props that match the regex
            var entriesToKeep = [];                
            if (options.postprocess.mangle.regex) {
                var regex = new RegExp(options.postprocess.mangle.regex);                
                entriesToKeep = entriesToKeep.concat(Array.from(options.postprocess.mangle.cache.props.entries()).filter(it => {
                    var result = regex.test(it[0]);                    
                    return result;
                }));
            }
            // keep the exports (reserve the prop map)                
            entriesToKeep = entriesToKeep.concat(Array.from(options.postprocess.mangle.cache.exports.entries()).filter(it => {
                return [it[1], it[0]];
            }));
            
            //  perform post process phase with only_cache enabled
            var localCache = new Map();
            localCache.props = new Map(entriesToKeep);
            options.postprocess.mangle.cache = localCache;
            options.postprocess.mangle.only_cache = true;

            DEBUG("postprocess start cache: ", options.postprocess.verbose);
            DEBUG(localCache, options.postprocess.verbose);

            toplevel = mangle_properties(toplevel, options.postprocess.mangle, options.postprocess.verbose);
        }
        //variable mangle must come after export and property mangling to allow property matching rules to effectively work
        if (options.mangle) {
            base54.reset();
            toplevel.compute_char_frequency(options.mangle);
            toplevel.mangle_names(options.mangle);
        }        
        if (timings) timings.output = Date.now();
        var result = {};
        if (options.output.ast) {
            result.ast = toplevel;
        }
        if (!HOP(options.output, "code") || options.output.code) {
            if (options.sourceMap) {
                if (typeof options.sourceMap.content == "string") {
                    options.sourceMap.content = JSON.parse(options.sourceMap.content);
                }
                options.output.source_map = SourceMap({
                    file: options.sourceMap.filename,
                    orig: options.sourceMap.content,
                    root: options.sourceMap.root
                });
                if (options.sourceMap.includeSources) {
                    if (files instanceof AST_Toplevel) {
                        throw new Error("original source content unavailable");
                    } else for (var name in files) if (HOP(files, name)) {
                        options.output.source_map.get().setSourceContent(name, files[name]);
                    }
                }
            }
            delete options.output.ast;
            delete options.output.code;
            var stream = OutputStream(options.output);
            toplevel.print(stream);
            result.code = stream.get();
            if (options.sourceMap) {
                if(options.sourceMap.asObject) {
                    result.map = options.output.source_map.get().toJSON();
                } else {
                    result.map = options.output.source_map.toString();
                }
                if (options.sourceMap.url == "inline") {
                    var sourceMap = typeof result.map === "object" ? JSON.stringify(result.map) : result.map;
                    result.code += "\n//# sourceMappingURL=data:application/json;charset=utf-8;base64," + to_base64(sourceMap);
                } else if (options.sourceMap.url) {
                    result.code += "\n//# sourceMappingURL=" + options.sourceMap.url;
                }
            }
        }
        if (options.nameCache && options.mangle) {
            if (options.mangle.cache) options.nameCache.vars = to_json(options.mangle.cache);
            if (options.mangle.properties && options.mangle.properties.cache) {
                options.nameCache.props = to_json(options.mangle.properties.cache);
            }
        }
        if (timings) {
            timings.end = Date.now();
            result.timings = {
                parse: 1e-3 * (timings.rename - timings.parse),
                rename: 1e-3 * (timings.compress - timings.rename),
                compress: 1e-3 * (timings.scope - timings.compress),
                scope: 1e-3 * (timings.mangle - timings.scope),
                mangle: 1e-3 * (timings.properties - timings.mangle),
                properties: 1e-3 * (timings.output - timings.properties),
                output: 1e-3 * (timings.end - timings.output),
                total: 1e-3 * (timings.end - timings.start)
            };
        }
        if (warnings.length) {
            result.warnings = warnings;
        }
        return result;
    } catch (ex) {
        return { error: ex };
    } finally {
        AST_Node.warn_function = warn_function;
    }
}

export {
  minify,
  to_ascii,
};
