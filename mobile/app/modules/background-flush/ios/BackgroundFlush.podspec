Pod::Spec.new do |s|
  s.name           = 'BackgroundFlush'
  s.version        = '1.0.0'
  s.summary        = 'Holds a short iOS background task while the Yappr engine flushes its storage.'
  s.description    = s.summary
  s.license        = 'MIT'
  s.author         = 'Yappr'
  s.homepage       = 'https://yap.pr'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
