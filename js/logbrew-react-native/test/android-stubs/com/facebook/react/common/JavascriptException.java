package com.facebook.react.common;

/** Test stand-in for the React Native class that ends a JavaScript fatal on Android. */
public class JavascriptException extends RuntimeException {
  public JavascriptException(String message) {
    super(message);
  }
}
